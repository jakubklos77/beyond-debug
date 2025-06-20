/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {
	logger,
	InitializedEvent, TerminatedEvent, StoppedEvent, OutputEvent,
	ProgressStartEvent, ProgressUpdateEvent, ProgressEndEvent,
	Thread, StackFrame, Source, Handles, Breakpoint, DebugSession, ContinuedEvent
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import *  as dbg from './dbgmits';

import * as vscode from 'vscode';
import { BeyDbgSession, BeyDbgSessionNormal } from './beyDbgSession';
import { TerminalEscape, TE_Style } from './terminalEscape';
import { TargetStopReason, IVariableInfo, IStackFrameInfo, IWatchInfo, IThreadInfo } from './dbgmits';
import * as iconv from 'iconv-lite';
import {showQuickPick} from './attachQuickPick';
import {NativeAttachItemsProviderFactory} from './nativeAttach';
import { AttachItemsProvider } from './attachToProcess';
import path = require('path');
// SSH import will be done dynamically to avoid loading native modules at startup
import { ILaunchRequestArguments,IAttachRequestArguments } from './argments';
import { isLanguagePascal } from './util';
import { log } from 'console';
import * as fs from 'fs';

function timeout(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function isFrameSame(f1?: IStackFrameInfo, f2?: IStackFrameInfo) {
	return (f1?.level === f2?.level) && (f1?.fullname === f2?.fullname) && (f1?.func === f2?.func);
}
enum EMsgType {
	info,	//black
	error,
	alert,
	info2,
	info3,
}
const EVENT_CONFIG_DOWN='configdown';
const NULL_POINTER = '0x0';
const NULL_LABEL = '<null>';

interface ILaunchArguments extends DebugProtocol.LaunchRequestArguments {
	varUpperCase?: boolean;
}

export class BeyDebug extends DebugSession {

	private _variableHandles = new Handles<string>();

	private _configurationDone:boolean = false;

	private _cancelationTokens = new Map<number, boolean>();
	private _cancelledProgressId: string;
	private _isRunning = false;
	private _isAttached = false;

	private _breakPoints = new Map<string, DebugProtocol.Breakpoint[]>();

	private _locals: { frame?: IStackFrameInfo, vars: IVariableInfo[], watch: IWatchInfo[] } = { frame: null, vars: [], watch: [] };

	private _watchs: Map<string, IWatchInfo> = new Map();

	private _currentFrameLevel = 0;
	private _currentThreadId?: IThreadInfo;

	private dbgSession: BeyDbgSession;

	private varUpperCase:boolean=false;

	//current language  of debugged program
	private language:string;
	private isPascal:boolean;

	//default charset
	private defaultStringCharset?:string;

	private isSSH=false;
	private workspathpath=vscode.workspace.workspaceFolders[0].uri.path;
	private sendMsgToDebugConsole(msg: string, itype: EMsgType = EMsgType.info) {
		let style = [TE_Style.Blue];
		// todo:vscode.window.activeColorTheme.kind is proposed-api in low version
		// if (vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark) {

		// 	style = [TE_Style.BrightWhite];
		// 	switch (itype) {
		// 		case EMsgType.error:
		// 			style = [TE_Style.Red];
		// 			break;
		// 		case EMsgType.info2:
		// 			style = [TE_Style.Blue];
		// 		case EMsgType.alert:
		// 			style = [TE_Style.Yellow];
		// 		default:
		// 			break;
		// 	}
		// } else {
		//	style = [TE_Style.Black];

			switch (itype) {
				case EMsgType.error:
					style = [TE_Style.Red];
					break;
				case EMsgType.info2:
					style = [TE_Style.Blue];
				case EMsgType.alert:
					style = [TE_Style.Yellow];
				default:
					break;
			}
		//}

		this.sendEvent(new OutputEvent(TerminalEscape.apply({ msg: msg, style: style })));

	}

	private waitForConfingureDone():Promise<void>{
		return new Promise<void>((resolve,reject)=>{
			if(this._configurationDone){
				resolve();
			}else{
				this.once(EVENT_CONFIG_DOWN,()=>{
					resolve();
				});
				if(this._configurationDone){
					resolve();
				}
			}
		});
	}
	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor() {
		super(true);
	}
	private async initDbSession(is_ssh:boolean){
		this.isSSH=is_ssh;
		if(is_ssh){
			// Dynamically import SSH functionality to avoid loading native modules at startup
			const { BeyDbgSessionSSH } = await import('./beyDbgSessionSSH');
			this.dbgSession = new BeyDbgSessionSSH('mi3');
		}else{
			this.dbgSession=new BeyDbgSessionNormal('mi3');
		}
		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);

		this.dbgSession.on(dbg.EVENT_SIGNAL_RECEIVED, (e: dbg.ISignalReceivedEvent) => {
			logger.log(e.reason.toString());
		});
		this.dbgSession.on(dbg.EVENT_DBG_CONSOLE_OUTPUT, (out: string) => {
			this.sendMsgToDebugConsole(out);
		});
		// this.dbgSession.on(dbg.EVENT_DBG_LOG_OUTPUT,(out: string) => {
		// 	this.sendMsgToDebugConsole(out,EMsgType.info2);
		// });
		this.dbgSession.on(dbg.EVENT_TARGET_RUNNING, (out) => {
			this._isRunning = true;
			logger.log(out);
		});
		this.dbgSession.on(dbg.EVENT_TARGET_STOPPED, (e: dbg.ITargetStoppedEvent) => {
			logger.log("stoped:" + e.reason.toString());
			this._isRunning = false;
			this._variableHandles.reset();


			switch (e.reason) {

				/** A breakpoint was hit. */
				case TargetStopReason.BreakpointHit:
				/** A step instruction finished. */
				case TargetStopReason.EndSteppingRange:
				/** A step-out instruction finished. */
				case TargetStopReason.FunctionFinished:
				/** The target was signalled. */
				case TargetStopReason.SignalReceived:
				/** The target encountered an exception (this is LLDB specific). */
				case TargetStopReason.ExceptionReceived:
					break;



				/** An inferior terminated because it received a signal. */
				case TargetStopReason.ExitedSignalled:
				/** An inferior terminated (for some reason, check exitCode for clues). */
				case TargetStopReason.Exited:
				/** The target finished executing and terminated normally. */
				case TargetStopReason.ExitedNormally:
					this.sendEvent(new TerminatedEvent(false));
					break;

				/** Catch-all for any of the other numerous reasons. */
				case TargetStopReason.Unrecognized:
				default:
					this.sendEvent(new StoppedEvent('Unrecognized', e.threadId));
			}

		});

		//'step', 'breakpoint', 'exception', 'pause', 'entry', 'goto', 'function breakpoint', 'data breakpoint', 'instruction breakpoint'
		this.dbgSession.on(dbg.EVENT_BREAKPOINT_HIT, (e: dbg.IBreakpointHitEvent) => {
			this.sendEvent(new StoppedEvent('breakpoint', e.threadId));
		});
		this.dbgSession.on(dbg.EVENT_STEP_FINISHED, (e: dbg.IStepFinishedEvent) => {
			this.sendEvent(new StoppedEvent('step', e.threadId));
		});
		this.dbgSession.on(dbg.EVENT_FUNCTION_FINISHED, (e: dbg.IStepOutFinishedEvent) => {
			this.sendEvent(new StoppedEvent('function breakpoint', e.threadId));
		});
		this.dbgSession.on(dbg.EVENT_SIGNAL_RECEIVED, (e: dbg.ISignalReceivedEvent) => {
			logger.log('signal_receive:'+e.signalCode);
			// If this is not handled then we receive select.c breakpoints when breakpoints are toggled in VSCode...
			if (e.signalName==='SIGINT')
				return;
			let event=new StoppedEvent('signal', e.threadId,e.signalMeaning);
			event.body['text']=e.signalMeaning;
			event.body['description']=e.signalMeaning;
			this.sendEvent(event);

			// Signal message
			vscode.window.showErrorMessage(`Signal occurred: ${e.signalName} ${e.signalMeaning}`);
		});
		this.dbgSession.on(dbg.EVENT_EXCEPTION_RECEIVED, (e: dbg.IExceptionReceivedEvent) => {
			this.sendEvent(new StoppedEvent('exception', e.threadId,e.exception));
		});

	}
	private resultString(value?:string,expressionType?:string):string{

		if (expressionType===undefined){
			return '';
		}
		if (this.defaultStringCharset){
			switch (this.language) {
				case 'c++':
					if(expressionType.endsWith('char *') ){
						let val=value;

						val=val.replace(/\\(\d+)/g,(s,args)=>{
							let num= parseInt( args,8);
							return String.fromCharCode(num);
						});
						if (val.endsWith("'")){
							val=val.substring(0,val.length-1);
						}

						let bf=val.split('').map((e)=>{return e.charCodeAt(0);});

						return iconv.decode(Buffer.from(bf),this.defaultStringCharset);
					}
					break;
				case 'pascal':

					// Decode and unescape string
					if (expressionType === 'ANSISTRING') {

						// Blank string
						if (value === "''")
							return value;

						let val = value;

						// convert #num to char
						let isQuote = false;
						let result = '';
						let isNum = false;
						let minLen = Math.min(val.length, 255);
						let lastQuoteIndex = -10;
						for (let i = 0; i < minLen; i++) {
							let ch = val[i];

							// Quote
							if (ch === '\'') {

								// Skip this quote after a numeric value
								if (!isQuote && isNum) {
									isNum = false;
									isQuote = true;
									continue;
								}

								// Quote escaping handle
								if (!isQuote && lastQuoteIndex == i-1)
									result += "''";
								if (isQuote)
									lastQuoteIndex = i;

								isQuote = !isQuote;

							// Numeric value
							} else if (!isQuote && ch === '#' && i + 1 < val.length) {
								let match = val.substring(i + 1).match(/^(\d+)/);
								if (match) {
									let num = parseInt(match[1], 10);
									result += String.fromCharCode(num);
									i += match[1].length; // Skip the digits
									isNum = true;
								}

							// Other
							} else {
								result += ch;
							}
						}

						let bf = result.split('').map((e)=>{return e.charCodeAt(0);});
						return "'" + iconv.decode(Buffer.from(bf),this.defaultStringCharset) + "'";

					}
					break;
				default:
					break;
			}


		}
		return value;

	}
	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {



		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// the adapter implements the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code to use 'evaluate' when hovering over source
		response.body.supportsEvaluateForHovers = true;

		// make VS Code to show a 'step back' button
		response.body.supportsStepBack = false;

		// make VS Code to support data breakpoints
		response.body.supportsDataBreakpoints = true;

		// make VS Code to support completion in REPL
		//todo
		response.body.supportsCompletionsRequest = false;
		response.body.completionTriggerCharacters = [".", "["];

		// make VS Code to send cancelRequests
		response.body.supportsCancelRequest = false;

		// make VS Code send the breakpointLocations request
		response.body.supportsBreakpointLocationsRequest = false;

		// make VS Code provide "Step in Target" functionality
		response.body.supportsStepInTargetsRequest = false;

		response.body.supportsTerminateThreadsRequest = true;


		response.body.supportsSetVariable=true;
		response.body.supportsSetExpression=true;
		response.body.supportsClipboardContext=true;

		response.body.supportsReadMemoryRequest = true;
		//todo
		response.body.supportsExceptionInfoRequest=false;

		this.sendResponse(response);

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);
		this._configurationDone=true;
		this.emit(EVENT_CONFIG_DOWN);
		//notify the launchRequest that configuration has finished

	}

	private checkPascalLanguage(args: ILaunchArguments) {

		// Detect pascal
		if (this.language == "auto") {
			if (isLanguagePascal()) {
				this.language = "pascal";
			}
		}
		this.isPascal = this.language == 'pascal';

		// Force upper case for pascal variables
		if (this.isPascal) {
			args.varUpperCase = true;
		}

		// Set common args
		this.varUpperCase = args.varUpperCase;
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, _args: DebugProtocol.LaunchRequestArguments ) {

		let args=_args as ILaunchRequestArguments;
		await this.initDbSession(args.ssh?true:false);
		//vscode.commands.executeCommand('workbench.panel.repl.view.focus');
		this.defaultStringCharset = args.defaultStringCharset ? args.defaultStringCharset : "utf-8";
		if(args.language){
			this.language=args.language;
		}else{
			this.language='auto';
		}

		this.checkPascalLanguage(args as ILaunchArguments);

		// make sure to 'Stop' the buffered logging if 'trace' is not set

		// wait until configuration has finished (and configurationDoneRequest has been called)
		try {
			await this.dbgSession.startIt(args);
			await this.waitForConfingureDone();
			//must wait for configure done. It will get error args without this.
			//await this._startDone.wait(2000);
			await this.dbgSession.waitForStart();
		} catch (error) {
			this.sendEvent(new TerminatedEvent(false));
			this.sendErrorResponse(response,500);
		}


		//await this.dbgSession.execNativeCommand('-gdb-set mi-async on');
		if (args.cwd) {
			await this.dbgSession.environmentCd(args.cwd);
		}
		if (args.commandsBeforeExec){
			for  (const cmd of args.commandsBeforeExec) {
				await this.dbgSession.execNativeCommand(cmd)
				.catch((e)=>{
					this.sendMsgToDebugConsole(e.message,EMsgType.error);
				});
			}
		}
		// start the program
		let ret = await this.dbgSession.setExecutableFile(args.program).catch((e) => {

			vscode.window.showErrorMessage("Failed to start the debugger." + e.message);
			this.sendEvent(new TerminatedEvent(false));

			this.sendMsgToDebugConsole(e.message, EMsgType.error);

			return 1;
		});
		if (typeof ret === 'number' && ret > 0) {
			return;
		}

		//set programArgs
		if(args.programArgs){
			await this.dbgSession.setInferiorArguments(args.programArgs);
		}

		if (args.remote?.enabled) {
			if (!args.remote.address) {
				vscode.window.showErrorMessage("Invalid remote addr.");
			}
			let mode: string = args.remote.mode === undefined ? 'remote' : args.remote.mode;
			if (mode === 'remote') {
				let result = await this.dbgSession.connectToRemoteTargetEx(args.remote.address).catch((e) => {
					this.sendMsgToDebugConsole(e.message, EMsgType.error);
					vscode.window.showErrorMessage(e.message);
					return 1;
				});
				if (typeof result === 'number' && result > 0) {
					this.sendEvent(new TerminatedEvent(false));
					return;
				}
				this.dbgSession.resumeInferior();
				this.sendResponse(response);
				return;

			} else if (mode === 'extended-remote') {
				let result = await this.dbgSession.connectToRemoteTargetEx(args.remote.address, mode).catch((e) => {
					this.sendMsgToDebugConsole(e.message, EMsgType.error);
					vscode.window.showErrorMessage(e.message);
					return 1;
				});
				if (typeof result === 'number' && result > 0) {
					this.sendEvent(new TerminatedEvent(false));
					return;
				}
				if (args.remote.transfer) {
					this.sendMsgToDebugConsole("\n");
					for (const trans of args.remote.transfer) {

						let id = "put" + trans.from;
						const startEvent: DebugProtocol.ProgressStartEvent = new ProgressStartEvent(id, `upload ${trans.from}`);
						startEvent.body.cancellable = false;
						this.sendEvent(startEvent);
						this.sendMsgToDebugConsole(`uploading : ${trans.from}\n`, EMsgType.info2);

						let endMessage = '`file uploaded : ${trans.from}';



						await this.dbgSession.targetFilePut(trans.from, trans.to).catch((e) => {
							vscode.window.showErrorMessage(e.message);
							this.sendEvent(new ProgressEndEvent(id, e.message));
						}).then(() => {
							this.sendMsgToDebugConsole(`file uploaded : ${trans.from}\n`, EMsgType.info2);
							this.sendEvent(new ProgressEndEvent(id, endMessage));
						}
						);
					}
				}


				let execfile = args.remote.execfile ? args.remote.execfile : args.program;
				await this.dbgSession.execNativeCommand(`set remote exec-file ${execfile}`).catch((e) => {
					vscode.window.showErrorMessage("Failed to start the debugger." + e.message);
					this.sendEvent(new TerminatedEvent(false));
					return 1;
				});;

			} else {
				vscode.window.showErrorMessage('Invalid remote mode.');
				this.sendEvent(new TerminatedEvent(false));
				return;

			}


		}
		if(this.language=="auto"){

			let checklang=(out:string)=>
			{
				if (out.indexOf('language')>0)
				{
					let m=out.match('currently (.*)?"') ;
					if ( m!==null){
						this.language=m[1];
					}
					this.dbgSession.off(dbg.EVENT_DBG_CONSOLE_OUTPUT,checklang);
				}
			};
			this.dbgSession.on(dbg.EVENT_DBG_CONSOLE_OUTPUT,checklang);
			await this.dbgSession.execNativeCommand('show language');


		}

		if (this.isPascal) {
			// Pascal exceptions
			await this.dbgSession.addFPCExceptionBreakpoint();
			await this.dbgSession.addFPCSignalStops();
		}

		await this.dbgSession.startInferior({stopAtStart: args.stopAtEntry}).catch((e) => {
			this.sendMsgToDebugConsole(e.message, EMsgType.error);
			vscode.window.showErrorMessage("Failed to start the debugger." + e.message);
			this.sendEvent(new TerminatedEvent(false));
		});
		this.sendResponse(response);
	}

	protected async attachRequest(response: DebugProtocol.AttachResponse, _args:DebugProtocol.AttachRequestArguments) {
		let args=_args as  IAttachRequestArguments;
		if(args.language){
			this.language=args.language;
		}else{
			this.language='auto';
		}

		this.checkPascalLanguage(args as ILaunchArguments);

		await this.initDbSession(false);
			//const attacher: AttachPicker = new AttachPicker(attachItemsProvider);


			// let s=await showQuickPick(()=>{
			// 	return attachItemsProvider.getAttachItems();
			// });



		//let s=await attacher.ShowAttachEntries();
		//let prov= NativeAttachItemsProviderFactory.Get();
		//let result=await showQuickPick(prov.getAttachItems);

		//vscode.commands.executeCommand('workbench.panel.repl.view.focus');
		this.defaultStringCharset = args.defaultStringCharset ? args.defaultStringCharset : "utf-8";

		// wait until configuration has finished (and configurationDoneRequest has been called)
		this.dbgSession.startIt(args);
		await this.waitForConfingureDone();
		//must wait for configure done. It will get error args without this.
		await this.dbgSession.waitForStart();
		//await this.dbgSession.execNativeCommand('-gdb-set mi-async on');
		if (args.cwd) {
			await this.dbgSession.environmentCd(args.cwd);
		}
		if (args.commandsBeforeExec){
			for (const  cmd of args.commandsBeforeExec) {
				await this.dbgSession.execNativeCommand(cmd).catch((e)=>{
					this.sendMsgToDebugConsole(e.message,EMsgType.error);
				});
			}
		}

		const attachItemsProvider: AttachItemsProvider = NativeAttachItemsProviderFactory.Get();


		let plist=await attachItemsProvider.getAttachItems();
		if(args.program){
			let pname=args.program;
			if(args.program.match(/[\\/]/)){
				pname=path.resolve(args.program);
			}
			//let pname=path.basename(args.program);

			plist=plist.filter(
				item=>{
					return (args.processId && item.id==args.processId.toString())||
					(item.detail && item.detail.toLowerCase().indexOf(pname)>-1)
				}
			);
			if(plist.length==0){
				//vscode.window.showErrorMessage(`parogam ${args.program} not found.`);
				this.sendErrorResponse(response,0,`parogam ${args.program} not found.`);
				return;
			}
		}
		if(plist.length==1){
			let pid=plist[0].id;
			args.processId=Number.parseInt(pid);

		}else if(plist.length>1){
			try {
				let pid=await showQuickPick(async  ()=>{return plist;} );
				args.processId=Number.parseInt(pid);
			} catch (error) {
				this.sendErrorResponse(response,0,(error as Error).message);
				return;
			}


		}

		try {
			await this.dbgSession.attach(args.processId);
		} catch (error) {

			//vscode.window.showErrorMessage();
			response.success=false;
			response.command='cancelled';
			response.message='Attach fail. '+(error as Error).message;

			this.sendResponse(response);
			return;
		}

		if (this.isPascal) {
			// Pascal exceptions
			await this.dbgSession.addFPCExceptionBreakpoint();
			await this.dbgSession.addFPCSignalStops();
		}

		await this.dbgSession.resumeInferior();
		this._isAttached=true;
		this.sendResponse(response);
	}

	protected async  pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments, request?: DebugProtocol.Request): Promise<void> {

		await this.dbgSession.pause();

		logger.log('pause');
		this.sendResponse(response);

	}


	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments) {

		//wait for gdb start
		await this.dbgSession.waitForStart();

		let isPause = false;
		if (this._isRunning) {
			await this.dbgSession.pause();
			isPause = true;
		}

		let srcpath = args.source.path as string;
		srcpath=path.normalize(srcpath);
		if(this.isPascal){ //pascal can find file use unit name
			if(!srcpath.startsWith(this.workspathpath)){
				srcpath=path.basename(srcpath);
			}
		}

		if (this._breakPoints.has(srcpath)) {
			let bps: number[] = [];

			this._breakPoints.get(srcpath).forEach((e) => {
				bps.push(e.id);
			});
			this._breakPoints.set(srcpath, []);
			this.dbgSession.removeBreakpoints(bps);

		}

		const clientLines = args.breakpoints || [];
		const actualBreakpoints = await Promise.all(clientLines.map(async l => {
			let bk = await this.dbgSession.addBreakpoint(srcpath + ":" + this.convertClientLineToDebugger(l.line), {
				isPending: true,
				condition: l.condition
			});
			//console.log(bk);
			const bp = new Breakpoint(false, this.convertDebuggerLineToClient(l.line)) as DebugProtocol.Breakpoint;
			bp.source = args.source;
			bp.verified = true;
			bp.id = bk.id;
			return bp;
		}));
		this._breakPoints.set(srcpath, actualBreakpoints);
		if (isPause) {
			this.dbgSession.resumeAllInferiors(false);
		}
		response.body = {
			breakpoints: actualBreakpoints
		};
		this.sendResponse(response);

	}

	protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): void {


		if (args.source.path) {
			response.body = {
				breakpoints: []
			};
		} else {
			response.body = {
				breakpoints: []
			};
		}
		this.sendResponse(response);
	}

	protected async threadsRequest(response: DebugProtocol.ThreadsResponse): Promise<void> {

		let threads: Thread[] = [];
		let r = await this.dbgSession.getThreads();
		this._currentThreadId = r.current;
		let idtype=0;
		if(r.current){
			if(r.current.targetId.startsWith('LWP')){
				idtype=1;
			}else if(r.current.targetId.startsWith('Thread')){
				idtype=2;
			}
		}
		r.all.forEach((th) => {
			if(idtype==1){
				let ids=th.targetId.split(' ');
				let tid=Number.parseInt(ids[1]);
				threads.push(new Thread(th.id, `Thread #${tid}`));

			}else if(idtype==2){
				let ids=th.targetId.split('.');
				let tid=Number.parseInt(ids[1]);
				threads.push(new Thread(th.id, `Thread #${tid} ${th.name?th.name:''}`));
			}else{
				threads.push(new Thread(th.id, th.targetId));
			}

		});
		response.body = {
			threads: threads
		};
		this.sendResponse(response);

	}

	protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {

		const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
		const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
		const endFrame = startFrame + maxLevels;

		const frames = await this.dbgSession.getStackFrames({ lowFrame: startFrame, highFrame: endFrame });

		//remove watchs
		for (const watch of this._watchs) {
			await this.dbgSession.removeWatch(watch[1].id).catch(() => { });;
		}
		this._watchs.clear();

		let sourceStackIndex = undefined;
		let fpcException = undefined;
		let stackIndex = 0;
		response.body = {
			stackFrames: frames.map(f => {

				// FPC exception
				if (f.level == 0 && f.func == 'fpc_raiseexception') {

					// Mark exception
					fpcException = f;
				}

				// Source index (use VSCode API to check if file exists)
				if (f.filename && f.fullname && sourceStackIndex === undefined) {
					if (fs.existsSync(f.fullname)) {
						sourceStackIndex = stackIndex;
					}
				}

				stackIndex++;

				return new StackFrame(
					f.level,
					f.func,
					f.filename ? new Source(f.filename!, f.fullname) : null,
					this.convertDebuggerLineToClient(f.line!)
				)}),
			totalFrames: frames.length
		};

		// FPC exceptions
		if (fpcException) {

			let exceptionName = "";

			// Get exception info for x86_64
			if (process.arch === 'x64') {

				let info = undefined;
				// Try *($rdi) and ($rdi)^ as both are used and sometimes on works and not the other
				try {
					info = await this.dbgSession.getFPCExceptionDataDisassemble("*($rdi)");
				} catch (error) {
					info = await this.dbgSession.getFPCExceptionDataDisassemble("($rdi)^");
				}

				if (info?.asm_insns[0]) {
					let funcName = info?.asm_insns[0]["func-name"];
					if (funcName) {
						exceptionName = funcName.match(/\$\$_(.*)$/)?.[1] || funcName;
					}
				}
			}

			// Exception error message
			vscode.window.showErrorMessage("Exception occurred: " + exceptionName);
		}

		// Stack without source file
		if (sourceStackIndex === undefined || sourceStackIndex != 0) {
			// Set the currently open file otherwise VSCode does not focus the thread in the Call stack list
			const editor = vscode.window.activeTextEditor;
			if (editor) {
				const document = editor.document;
				const fileName = document.fileName;
				const cursorPosition = editor.selection.active;

				// Set it to frame 0 so VSCode focuses the thread
				if (sourceStackIndex === undefined) {
					response.body.stackFrames[0].source = new Source('Exception', fileName);
					response.body.stackFrames[0].line = cursorPosition.line + 1;

				// Set it to the first source frame
				} else {
					response.body.stackFrames[0].source = response.body.stackFrames[sourceStackIndex].source;
					response.body.stackFrames[0].line = response.body.stackFrames[sourceStackIndex].line;
				}
			}
		}


		this.sendResponse(response);
	}

	protected async scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments) {

		this._currentFrameLevel = args.frameId;


		response.body = {
			scopes: [
				{
					name: "Locals",
					presentationHint:"locals",
					variablesReference: this._variableHandles.create("locals::"),
					expensive: false
				},
			]
		};
		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request) {

		const variables: DebugProtocol.Variable[] = [];

		const id = this._variableHandles.get(args.variablesReference);

		// Local variables
		if (id === 'locals::') {
			for (const w of this._locals.watch) {
				await this.dbgSession.removeWatch(w.id).catch(() => { });
			}
			this._locals.watch=[];
			let vals = await this.dbgSession.getStackFrameVariables(dbg.VariableDetailLevel.Simple, {
				frameLevel: this._currentFrameLevel,
				threadId: this._currentThreadId?.id
			});
			this._locals.vars = vals.args.concat(vals.locals);

			for (const v of this._locals.vars) {

				let c = await this.dbgSession.addWatch(v.name, {
					frameLevel: this._currentFrameLevel,
					threadId: this._currentThreadId?.id
				}).catch(() => {

				});
				if (!c)
					continue;

				await this.handleWatchProcessor(c);

				this._locals.watch.push(c);

				let vid = 0;
				if (c.childCount > 0 && c.value !== NULL_POINTER) {
				  vid = this._variableHandles.create(c.id);
				}

				variables.push({
					name: v.name,
					type: c.expressionType,
					value: c.value,
					variablesReference: vid
				});

			}

		} else {

			// Array list handling
			if (id.startsWith('**ARRAY**')){

				// Get vid
				let vid = id.replace('**ARRAY**','');

				// Get id:length
				let strs = vid.split(':');

				// Count of items
				let cnt = strs[strs.length - 1];

				for (var i = 0; i < Number.parseInt(cnt); i++) {
					if (i > 100) {
						variables.push({
							name: '[.]',
							type: 'string',
							value: '...',
							variablesReference: 0
						});
						break;
					} else {
						// Get exp
						let exp = await this.dbgSession.getWatchExpression(strs[0]);
						exp = exp.replace('->', '.');
						exp = exp + "^[" + i + "]"

						// Add new watch
						let c = await this.dbgSession.addWatch(exp, {
							frameLevel: this._currentFrameLevel,
							threadId: this._currentThreadId?.id
						}).catch(() => {
						});

						// Create and push a new array member linking to the watch
						if (c) {
							let newVid = this._variableHandles.create(c.id);
							variables.push({
								name: '[' + i + ']',
								type: c.expressionType,
								value: '{...}',
								variablesReference: newVid
							});
						}
					}
				}

			} else {

				let childs = await this.dbgSession.getWatchChildren(id, { detail: dbg.VariableDetailLevel.All }).catch((e) => {
					return [];
				});
				for (const c of childs) {
					let vid = 0;

					await this.handleWatchProcessor(c);

					if (c.childCount > 0 && c.value !== NULL_POINTER) {
					   vid = this._variableHandles.create(c.id);
					}

				   variables.push({
					   name: c.expression,
					   type: c.expressionType,
					   value: c.value,
					   variablesReference: vid
				   });

			   }
			}

		}

		response.body = {
			variables: variables
		};
		this.sendResponse(response);
	}
	protected async setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments, request?: DebugProtocol.Request)
    {
		let ret=args.value;
		let vid= this._variableHandles.get( args.variablesReference);
		try {
			if (vid==='locals::'){
				let watch=await this.dbgSession.addWatch(args.name);
				ret=await this.dbgSession.setWatchValue(watch.id,args.value);
				this.dbgSession.removeWatch(watch.id);
			}else{
				let childs=await this.dbgSession.getWatchChildren(vid,{ detail: dbg.VariableDetailLevel.Simple });
				let watch=childs.find((value,index,obj)=>{
					return value.expression===args.name;
				});
				if (watch){
					ret=await this.dbgSession.setWatchValue(watch.id,args.value);
				}

			}
			response.body={
				value:ret
			};
		} catch (error) {
			response.success=false;
		}


		this.sendResponse(response);
	}
	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this.dbgSession.resumeAllInferiors(false);
		this.sendResponse(response);
	}

	protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments): void {
		this.dbgSession.resumeAllInferiors(true);
		this.sendResponse(response);
	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this.dbgSession.stepOverLine({ threadId: args.threadId });
		this.sendResponse(response);
	}


	protected stepInTargetsRequest(response: DebugProtocol.StepInTargetsResponse, args: DebugProtocol.StepInTargetsArguments) {
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {

		this.dbgSession.stepIntoLine({ threadId: args.threadId, });
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		this.dbgSession.stepOut({ threadId: args.threadId });
		this.sendResponse(response);
	}

	private async handleWatchProcessor(watch: IWatchInfo): Promise<boolean> {

		if (this.isPascal) {

			// AnsiString
			if (watch.expressionType == 'ANSISTRING') {
				// check if value not blank
				if (watch.value != NULL_POINTER) {
					// get just the string
					watch.value = this.resultString(watch.value.split(' ').slice(1).join(' '), watch.expressionType);
				} else {
					watch.value = "''";
				}
				watch.childCount = 0;
				watch.expressionType = 'string';

				return true;
			}

			// Get short string value
			let shortString = await this.getShortStringValue(watch.expressionType, watch.childCount, watch.id);
			if (shortString !== undefined) {
				watch.value = this.resultString(shortString, "ANSISTRING");
				watch.childCount = 0;
				watch.expressionType = 'string';

				return true;
			}

			// Get array
			if (await this.processArrayValue(watch))
				return true;

			// Null pointer
			if (watch.value === NULL_POINTER) {
				watch.value = NULL_LABEL;
				watch.childCount = 0;

				return true;
			}
		}

		return false;
	}

	private async processArrayValue(watch: IWatchInfo): Promise<boolean> {


		// We have an array of
		if (watch.expressionType.match(/array of .+/) || watch.id.includes('.*')) {

			// Special var.*<OBJ> VSCode hover issue
			if (watch.id.includes('.*')) {
				// Get the starting var id
				let strs = watch.id.split('.*');
				watch.id = strs[0];
			}

			// Get address
			let address = await this.dbgSession.getWatchValue(watch.id);

			// 0x0
			if (address === NULL_POINTER) {
				watch.value = '[0]';
				watch.childCount = 0;
				return true;
			}

			// We have a pointer and a value (0x234242 value)
			if (address.includes(' ')) {

				// Get the value
				let strs = address.split(' ').slice(1).join(' ');

				watch.value = strs;
				watch.childCount = 0;
				return true;
			}

			let length = 0;

			// Special argument array FPC gdb bug
			if (address == '[0]') {

				return false;

			// Address is a pointer
			} else {

				// Get length
				let memory = undefined
				try {
					memory = await this.dbgSession.getAddressInt(address + '-8');
					if (memory === undefined)
						return false;
				} catch {
					return false;
				}

				// Convert hexLen to a number
				length = parseInt(memory.memory[0].data[0], 16);
				if (isNaN(length))
					return false;
			}

			// 0x00 address 0 items
			// non zero address +1 items
			length++;

			// Mark id as an array
			watch.id = '**ARRAY**' + watch.id + ':' + length;
			watch.value = '[' + length + ']';
			watch.childCount = length;
			return true;
		}
		return false;
	}

	private async getShortStringValue(expressionType: string, childCount: number, id: string): Promise<string | undefined> {

		// Short string handling (we may have a string)
		if (/string/i.test(expressionType) && childCount == 2) {

			// Get its children
			let stringChilds = await this.dbgSession.getWatchChildren(id, { detail: dbg.VariableDetailLevel.All }).catch((e) => {
				return [];
			});

			// Check if we have a short string
			if (stringChilds.length == 2) {

				// We have a short string indeed
				if (stringChilds[0].expression == 'length' && stringChilds[1].expression == 'st') {
					let stringArr = await this.dbgSession.getWatchChildren(stringChilds[1].id, { detail: dbg.VariableDetailLevel.All }).catch((e) => {
						return [];
					});

					// Get the value
					let strLen = stringChilds[0].value;
					let strVal = '';
					let isQuote = false;
					let isNoneValue = false;
					let minLen = Math.min(strLen, stringArr.length);
					for (let i = 0; i < minLen; i++) {
						let charInt = parseInt(stringArr[i].value)
						let ch = '';
						if (charInt > 127) {
							if (isQuote) {
								strVal += '\'';
								isQuote = false;
							}
							ch = '#' + charInt;

						} else {
							if (!isQuote) {
								strVal += '\'';
								isQuote = true;
							}
							if (isNaN(charInt)) {
								isNoneValue = true;
								break;
							}
							ch = String.fromCharCode(charInt);
							if (ch == '\'')
								ch += '\'';
						}
						strVal += ch;
					}
					if (isQuote)
						strVal += '\'';
					if (strVal == '')
						strVal = "''";

					// We have a NaN value
					if (isNoneValue) {

						// Get expression from var and check if no '.' in the name (probably a constant)
						let exp = await this.dbgSession.getWatchExpression(id);
						if (!exp.includes('.')) {

							// Evaluate the expression
							let dataStr = await this.dbgSession.evaluateExpression(exp).catch((e) => {
								return strVal;
							});

							// Convert to string
							strVal = this.resultString(dataStr, 'ANSISTRING');
						}
					}

					return strVal;
				}
			}
		}

		return undefined;
	}

	protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments) {
		if (args.context === 'repl') {
			let val = await this.dbgSession.execNativeCommand(args.expression).catch((e)=>{
				this.sendMsgToDebugConsole(e.message,EMsgType.error);
			});;
		} else { //'watch hover'
			if (this._currentFrameLevel!==args.frameId){
				this.dbgSession.selectStackFrame({frameLevel:args.frameId});

			}
			let key = this._currentThreadId?.id + "_" + args.frameId + "_" + args.expression;
			let watch: void | IWatchInfo = this._watchs.get(key);

			if (!watch) {
				let exp = this.varUpperCase?args.expression.toUpperCase():args.expression;
				watch = await this.dbgSession.addWatch(exp, {
					frameLevel: args.frameId,
					threadId: this._currentThreadId?.id
				}).catch((e) => { });

				// We have a pascal and a dotted expression (probably a class with a member that uses a function Getter
				if (!watch && this.isPascal && exp.includes('.')) {

					// Replace all . with .F (lets look for a hidden "F" variable in the class)
					let newExp = exp.replace(/\.(?!FF)(\w)/g, '.F$1');

					// Try again
					watch = await this.dbgSession.addWatch(newExp, {
						frameLevel: args.frameId,
						threadId: this._currentThreadId?.id
					}).catch((e) => { });
					}

				if (!watch) {
					response.body = {
						result: '<null>',
						type: undefined,
						variablesReference: 0
					};
					this.sendResponse(response);
					return;
				}

				await this.handleWatchProcessor(watch);

				this._watchs.set(key, watch);

			} else {
				let upd = await this.dbgSession.updateWatch(watch.id, dbg.VariableDetailLevel.Simple)
					.catch(() => { });
				if (upd) {
					if (upd.length > 0) {
						watch.value = upd[0].value;
						watch.expressionType = upd[0].expressionType;
						watch.childCount = upd[0].childCount;
					}

					await this.handleWatchProcessor(watch);
				}
			}

			let vid = 0;
			if (watch.childCount > 0 && watch.value !== NULL_POINTER) {
				vid = this._variableHandles.create(watch.id);
			}
			response.body = {
				result: watch.value,
				type: watch.expressionType,
				variablesReference: vid
			};
		}

		this.sendResponse(response);
	}

	protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments): void {

		response.body = {
			dataId: null,
			description: "cannot break on data access",
			accessTypes: undefined,
			canPersist: false
		};

		if (args.variablesReference && args.name) {
			const id = this._variableHandles.get(args.variablesReference);
			if (id.startsWith("global_")) {
				response.body.dataId = args.name;
				response.body.description = args.name;
				response.body.accessTypes = ["read"];
				response.body.canPersist = true;
			}
		}

		this.sendResponse(response);
	}

	protected setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments): void {

		this.sendResponse(response);
	}

	protected async completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments) {

		//Not realized
		let aval = await this.dbgSession.interpreterExec(`complete ${args.text}`);
		response.body = {
			targets: [
				{
					label: "item 10",
					sortText: "10"
				},
				{
					label: "item 1",
					sortText: "01"
				},
				{
					label: "item 2",
					sortText: "02"
				},
				{
					label: "array[]",
					selectionStart: 6,
					sortText: "03"
				},
				{
					label: "func(arg)",
					selectionStart: 5,
					selectionLength: 3,
					sortText: "04"
				}
			]
		};
		this.sendResponse(response);
	}

	protected cancelRequest(response: DebugProtocol.CancelResponse, args: DebugProtocol.CancelArguments) {
		if (args.requestId) {
			this._cancelationTokens.set(args.requestId, true);
		}
		if (args.progressId) {
			this._cancelledProgressId = args.progressId;
		}
	}
	protected sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments, request?: DebugProtocol.Request): void {
		logger.log(args.source!.path!);
	}


	protected async disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request) {
		try {
			if (this._isRunning) {

				try {
					await this.dbgSession.pause();
				} catch (error) {
					this.dbgSession.kill();
				}

			}
			if(this._isAttached){
				await this.dbgSession.executeCommand('target-detach');
				await this.dbgSession.dbgexit();
			}else{
				//this.dbgSession.kill();
				//await this.dbgSession.execNativeCommand('kill');
				await this.dbgSession.dbgexit();
			}
		} catch (error) {
			await this.dbgSession.kill();
		}

		this.sendResponse(response);
	}

	protected async  restartFrameRequest(response: DebugProtocol.RestartFrameResponse, args: DebugProtocol.RestartFrameArguments, request?: DebugProtocol.Request){
		logger.log(args.frameId.toString());
	}
	protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, args: DebugProtocol.ExceptionInfoArguments, request?: DebugProtocol.Request): void{

		//todo
		// response.body={
		// 	exceptionId:'1',
		// 	description:'test',
		// 	breakMode:'always',
		// 	details:{
		// 		message:'test2'
		// 	}

		// };
		this.sendResponse(response);
	}

	protected readMemoryRequest(response: DebugProtocol.ReadMemoryResponse, args: DebugProtocol.ReadMemoryArguments, request?: DebugProtocol.Request){

		this.sendResponse(response);

	}

	public getBeyDbgSession():BeyDbgSession{
		return this.dbgSession;
	}
}
