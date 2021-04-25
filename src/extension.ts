import * as cp from 'child_process';
import * as commandExists from 'command-exists-promise';
import * as path from 'path';
import * as net from 'net';
import {
	commands,
	debug,
	DebugAdapterDescriptor,
	DebugAdapterDescriptorFactory,
	DebugAdapterExecutable,
	DebugSession,
	env,
	ExtensionContext,
	OutputChannel,
	Uri,
	window,
	workspace,
} from 'vscode';
import {
	RAL,
	Disposable,
} from 'vscode-jsonrpc';
import {
	CommonLanguageClient,
	integer,
	LanguageClientOptions,
	MessageTransports,
	ReadableStreamMessageReader,
	WriteableStreamMessageWriter,
} from 'vscode-languageclient';
import * as WebSocket from 'ws';

const MINC_BIN = process.env['MINC_BIN'];
const MINC_PATH = MINC_BIN === undefined ? 'minc' : path.join(MINC_BIN, 'minc');

let client: LanguageClient;

class ReadableStreamWrapper implements RAL.ReadableStream
{
	constructor(private stream: NodeJS.ReadableStream) {
	}

	public onClose(listener: () => void): Disposable
	{
		this.stream.on('close', listener);
		return Disposable.create(() => this.stream.off('close', listener));
	}

	public onError(listener: (error: any) => void): Disposable
	{
		this.stream.on('error', listener);
		return Disposable.create(() => this.stream.off('error', listener));
	}

	public onEnd(listener: () => void): Disposable
	{
		this.stream.on('end', listener);
		return Disposable.create(() => this.stream.off('end', listener));
	}

	public onData(listener: (data: Uint8Array) => void): Disposable
	{
		this.stream.on('data', listener);
		return Disposable.create(() => this.stream.off('data', listener));
	}
}

class WritableStreamWrapper implements RAL.WritableStream
{
	constructor(private stream: NodeJS.WritableStream)
	{
	}

	public onClose(listener: () => void): Disposable
	{
		this.stream.on('close', listener);
		return Disposable.create(() => this.stream.off('close', listener));
	}

	public onError(listener: (error: any) => void): Disposable
	{
		this.stream.on('error', listener);
		return Disposable.create(() => this.stream.off('error', listener));
	}

	public onEnd(listener: () => void): Disposable
	{
		this.stream.on('end', listener);
		return Disposable.create(() => this.stream.off('end', listener));
	}

	public write(data: Uint8Array | string, encoding?: RAL.MessageBufferEncoding): Promise<void>
	{
		return new Promise((resolve, reject) => {
			const callback = (error: Error | undefined | null) => {
				if (error === undefined || error === null)
					resolve();
				else
					reject(error);
			};
			if (typeof data === 'string')
				this.stream.write(data, encoding, callback);
			else
				this.stream.write(data, callback);
		});
	}

	public end(): void
	{
		this.stream.end();
	}
}

interface StreamInfo
{
	writer: NodeJS.WritableStream;
	reader: NodeJS.ReadableStream;
	detached?: boolean;
}
type ServerOptions = (() => Promise<StreamInfo>);
class LanguageClient extends CommonLanguageClient
{
	private _serverOptions: ServerOptions;
	public constructor(id: string, name: string, serverOptions: ServerOptions, clientOptions: LanguageClientOptions)
	{
		super(id, name, clientOptions);
		this._serverOptions = serverOptions;
	}
	protected getLocale(): string
	{
		interface NLS_CONFIG
		{
			locale: string;
		}
		const envValue = process.env['VSCODE_NLS_CONFIG'];
		if (envValue === undefined) {
			return 'en';
		}

		let config: NLS_CONFIG | undefined = undefined;
		try 
		{
			config = JSON.parse(envValue);
		} catch (err) {
		}
		if (config === undefined || typeof config.locale !== 'string') {
			return 'en';
		}
		return config.locale;
	}
	protected createMessageTransports(encoding: string): Promise<MessageTransports>
	{
		return this._serverOptions().then((result: StreamInfo): MessageTransports => {
			return {
				reader: new ReadableStreamMessageReader(new ReadableStreamWrapper(result.reader)),
				writer: new WriteableStreamMessageWriter(new WritableStreamWrapper(result.writer))
			};
		});
	}
}

class DebugAdapterFactory implements DebugAdapterDescriptorFactory
{
	createDebugAdapterDescriptor(session: DebugSession, executable: DebugAdapterExecutable | undefined): DebugAdapterDescriptor
	{
		if (executable)
			return executable;
		else
			return new DebugAdapterExecutable(MINC_PATH, ["debug", session.configuration.program], {
				env: {
					"LD_LIBRARY_PATH": MINC_BIN
				}
			});
	}
}

async function validateMinc()
{
	// Check if minc binary is installed
	if (await commandExists(MINC_PATH) == false) { // If minc binary wasn't found, ...
		const result = await window.showErrorMessage("Can't find minc binary. " +
			"If minc is installed, make sure it is on PATH or set MINC_BIN environment variable.",
			"Install minc from github"
		);
		if (result == "Install minc from github")
			env.openExternal(Uri.parse('https://github.com/RcSepp/minc'));
		return false;
	}

	// Validate minc binary
	var binaryIsValid = false;
	for await (const output of cp.exec(MINC_PATH + ' help').stdout) {
		if (output.startsWith("Minimal Compiler"))
			binaryIsValid = true;
	};
	if (!binaryIsValid) {
		await window.showErrorMessage("Minc binary failed sanity check. " +
			"Language server may not run."
		);
		// Continue if binaryIsValid == false, because Minc may not actually be broken
	}

	// Check if environment variables MINC_PATH is set
	if (!process.env['MINC_PATH']){
		window.showWarningMessage("MINC_PATH not set. " +
			"Minc wouldn't be able to find packages."
		);
	}

	// Check if environment variables MINC_EXT is set
	if (!process.env['MINC_EXT']){
		window.showWarningMessage("MINC_EXT not set. " +
			"Minc wouldn't be able to find extensions."
		);
	}

	return true; 
}

function startServer(outputChannel: OutputChannel)
{
	const server = cp.exec(MINC_PATH + ' server');
	server.stdout.setEncoding('utf8').on('data', (chunk: any) => { outputChannel.appendLine(chunk.toString()); })
	server.stderr.setEncoding('utf8').on('data', (chunk: any) => { outputChannel.appendLine(chunk.toString()); });
}

function startClient(outputChannel: OutputChannel, socket: WebSocket | null)
{
	// The log to send
	let log = '';
	const websocketOutputChannel: OutputChannel = {
		name: 'websocket',
		// Only append the logs but send them later
		append(value: string) {
			log += value;
			console.log(value);
		},
		appendLine(value: string) {
			log += value;
			// Don't send logs until WebSocket initialization
			if (socket && socket.readyState === WebSocket.OPEN) {
				socket.send(log);
			}
			log = '';
		},
		clear() {},
		show() {},
		hide() {},
		dispose() {}
	};

	let serverOptions = () => {
		// Connect to language server via socket
		let socket = net.connect({
			port: 9333,
			host: "127.0.0.1",
			timeout: 60,
		});
		let result: StreamInfo = {
			writer: socket,
			reader: socket,
		};
		return Promise.resolve(result);
	};

	// Options to control the language client
	let clientOptions: LanguageClientOptions = {
		// Register the server for minc code documents
		documentSelector: [{ scheme: 'file', language: 'minc' }],
		synchronize: {
			// Notify the server about file changes to '.clientrc files contained in the workspace
			fileEvents: workspace.createFileSystemWatcher('**/.clientrc')
		},
		// Hijacks all LSP logs and redirect them to a specific port through WebSocket connection
		outputChannel: websocketOutputChannel
	};

	// Create and start the language client
	client = new LanguageClient(
		'mincLanguageServer',
		'Minc Language Server',
		serverOptions,
		clientOptions
	);
	client.start();
}


export function activate(context: ExtensionContext)
{
	// Create output channel
	let outputChannel: OutputChannel = window.createOutputChannel('minc-lsp');

	// Create debug adapter
	context.subscriptions.push(debug.registerDebugAdapterDescriptorFactory('minc', new DebugAdapterFactory()));
	
	const socketPort = workspace.getConfiguration('minc').get('logStreamingPort', 7000);
	let socket: WebSocket | null = null;
	
	commands.registerCommand('minc.streamLogs', () => {
		// Establish websocket connection
		socket = new WebSocket(`ws://localhost:${socketPort}`);
	});

	validateMinc().then(valid => {
		if (valid) {
			// Start server
			startServer(outputChannel);
			outputChannel.appendLine("Server started");

			// Start client
			setTimeout(() => {
				startClient(outputChannel, socket);
				outputChannel.appendLine("Client started");
			}, 1000); //TODO: Why is this still necessary when using client timeout != 0?
					//Note: Without this the client fails to connect unless activated at startup.
		}
	}).catch(reason => {
		window.showErrorMessage("Error during minc validation: " + reason);
	});
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}
