import * as vscode from 'vscode';
import { BeyDebug } from './beyDebug';

var currentDebug: BeyDebug;
var currentStepMode: boolean = false;

export function setCurrentDebugSession(dbg: BeyDebug) {
  currentDebug = dbg;
}

export async function cmdToggleStepMode(te: vscode.TextEditor) {

  let dbg = currentDebug.getBeyDbgSession();

  currentStepMode = !currentStepMode;
  await dbg.setStepMode(currentStepMode);
}

export async function cmdStepModeOn(te: vscode.TextEditor) {

  let dbg = currentDebug.getBeyDbgSession();

  currentStepMode = true
  await dbg.setStepMode(currentStepMode);
}

export async function cmdStepModeOff(te: vscode.TextEditor) {

  let dbg = currentDebug.getBeyDbgSession();

  currentStepMode = false
  await dbg.setStepMode(currentStepMode);
}
