// Copyright 2021 HITCON Online Contributors
// SPDX-License-Identifier: BSD-2-Clause

import assert from 'assert';
import fs from 'fs';
import {randomShuffle, randomChoice} from '../../common/utility/random-tool.mjs';
import InteractiveObjectServerBaseClass from '../../common/interactive-object/server.mjs';
import {getRunPath, getConfigPath} from '../../common/path-util/path.mjs';

// Boilerplate for getting require() in es module.
import {createRequire} from 'module';
const require = createRequire(import.meta.url);

const totp = require('totp-generator');

// Bring out the FSM_ERROR for easier reference.
const FSM_ERROR = InteractiveObjectServerBaseClass.FSM_ERROR;

const SF_PREFIX = 's2s_sf_';

/**
 * This represents the standalone extension service for this extension.
 */
class Standalone {
  /**
   * Create the standalone extension service object but does not start it.
   * @constructor
   * @param {ExtensionHelper} helper - An extension helper object for servicing
   * various functionalities of the extension.
   */
  constructor(helper) {
    this.helper = helper;

    // Stores the editable dialog variables
    this.dialogVars = {};
  }

  /**
   * Initializes the extension.
   */
  async initialize() {
  }

  /**
   * Provide the state functions in this extension to other interactive object.
   */
  async s2s_provideStateFunc(srcExt, registerFunc) {
    this.helper.callS2sAPI(srcExt, registerFunc, this.helper.getListOfStateFunctions(this));
  }

  // ==================== State Functions ====================

  /**
   * Show a dialog overlay in client browser.
   * @param {String} playerID
   * @param {Object} kwargs - TODO
   * @return {String} - the next state
   */
  async s2s_sf_showDialog(srcExt, playerID, kwargs, sfInfo) {
    const {dialogs, dialogVar, options} = kwargs;
    // prepare dialog
    let d = '';
    if (typeof dialogs === 'string') d = dialogs;
    if (Array.isArray(dialogs)) d = randomChoice(dialogs);
    if (typeof dialogVar === 'string' && typeof this.dialogVars[dialogVar] === 'string') d = this.dialogVars[dialogVar];

    // prepare choice
    const c = [];
    for (const [message, nextState] of Object.entries(options)) {
      c.push({token: nextState, display: message});
    }

    const result = await this.helper.callS2cAPI(playerID, 'dialog', 'showDialogWithMultichoice', 60*1000, sfInfo.visibleName, d, c);
    if (result.token) return result.token;
    console.warn(`Player '${playerID}' does not choose in 'showDialogWithMultichoice'. Result: ${JSON.stringify(result)}`);

    // If we reach here, the showDialog timeouts.
    return FSM_ERROR;
  }

  /**
   * Show an open-ended dialog and check if the entered value is
   * the same as the result.
   */
  async s2s_sf_showDialogAndCheckKey(srcExt, playerID, kwargs, sfInfo) {
    const {nextState, nextStateIncorrect, dialog, key} = kwargs;
    const res = await this.helper.callS2cAPI(playerID, 'dialog',
    'showDialogWithPrompt', 60*1000, sfInfo.visibleName, dialog);
    if (res.msg === key) return nextState;

    //The key is wrong,
    return nextStateIncorrect;
  }

  /**
   * Verify if the totp for secret within window is correct.
   */
  _checkOtpWithWindow(secret, target, wind) {
    const now = new Date().getTime();
    for (let i = 0; i < wind*2+1; i++) {
      const tryTime = now+(i-wind)*30*1000;
      const ref = totp(secret, {timestamp: tryTime});
      if (ref === target) return true;
    }
    return false;
  }

  /**
   * Show an open-ended dialog and check if the entered value is
   * correct, interpreting the entered values as an totp.
   */
  async s2s_sf_showDialogAndCheckTOTP(srcExt, playerID, kwargs, sfInfo) {
    const {nextState, nextStateIncorrect, dialog, secret, otpWindow} = kwargs;
    const res = await this.helper.callS2cAPI(playerID, 'dialog',
        'showDialogWithPrompt', 60*1000, sfInfo.visibleName, dialog);

    // Defaults to 60 seconds of leniency.
    const wind = otpWindow ?? 2;

    if (this._checkOtpWithWindow(secret, res.msg, wind)) return nextState;

    //The key is wrong,
    return nextStateIncorrect;
  }

  /**
   * Randomly draw from a set of problems, and move to the correct state
   * only when the player correctly answers goalPoints of them.
   */
  async s2s_sf_answerProblems(srcExt, playerID, kwargs, sfInfo) {
    const {problems, goalPoints, nextState, nextStateIncorrect} = kwargs;
    const file = kwargs.file ? kwargs.file : 'problems.json';
    if (!Number.isInteger(problems)) {
      console.error('Invalid number of problems: ', problems);
      return FSM_ERROR;
    }
    let problemSet = JSON.parse(fs.readFileSync(getRunPath(`items/${file}`)));
    randomShuffle(problemSet);
    let result, correct = 0, d = '';
    for (let i = 0; i < problems; i++) {
      const c = [];
      d = problemSet[i].dialogs;
      for (const option of problemSet[i].options) {
        c.push({token: option[0], display: option});
      }
      result = await this.helper.callS2cAPI(playerID, 'dialog', 'showDialogWithMultichoice', 60*1000, sfInfo.visibleName, d, c);
      if (!result.token) {
        console.warn(`Player '${playerID}' does not choose in 'answerProblems'. Result: ${JSON.stringify(result)}`);
        return FSM_ERROR;
      } else if (result.token === problemSet[i].ans) correct += 1;
    }
    if (correct >= goalPoints) return nextState;
    return nextStateIncorrect;
  }

  /**
   * Teleport the player to the target location.
   */
  async s2s_sf_teleport(srcExt, playerID, kwargs, sfInfo) {
    const {mapCoord, nextState} = kwargs;
    let allowOverlap = kwargs.allowOverlap;
    if (allowOverlap !== false) {
      allowOverlap = true;
    }
    const result = await this.helper.teleport(playerID, mapCoord, allowOverlap);

    if (result) return nextState;
    console.warn(`Player '${playerID}' cannot go to the place`);

    return FSM_ERROR;
  }

  /**
   * Check permission by JWT token and go to corresponding state
   * @param {String} playerID
   * @param {Object} kwargs - TODO
   * @return {String} - the next state
   */
  async s2s_sf_checkPermission(srcExt, playerID, kwargs, sfInfo) {
    const permission = await this.helper.getToken(playerID);
    const {options} = kwargs;
    let scp = permission.scp;
    if (!Array.isArray(scp)) {
      scp = permission.scope;
    }
    if (typeof scp === 'string') {
      scp = scp.split(' ');
    }
    if (Array.isArray(scp)) {
      for (const [identity, nextState] of Object.entries(options)) {
        if (scp.includes(identity)) {
          return nextState;
        }
      }
    }
    // No identity match and return default next state
    return options['default'];
  }

  /**
   * Show an input prompt for user to edit the content of dialog.
   * @param {String} playerID
   * @param {Object} kwargs - TODO
   * @return {String} - the next state
   */
  async s2s_sf_editDialog(srcExt, playerID, kwargs, sfInfo) {
    const {dialogs, dialogVar, buttonText, nextState} = kwargs;

    // prepare dialog
    let d = '';
    if (typeof dialogs === 'string') d = dialogs;
    if (Array.isArray(dialogs)) d = randomChoice(dialogs);

    const result = await this.helper.callS2cAPI(playerID, 'dialog', 'showDialogWithPrompt', 60*1000, sfInfo.visibleName, d, buttonText);
    if (result.msg) {
      if (typeof dialogVar === 'string') {
        this.dialogVars[dialogVar] = result.msg;
      }
      return nextState;
    }
    console.warn(`Player '${playerID}' does not choose in 'showDialogWithMultichoice'. Result: ${JSON.stringify(result)}`);

    // If we reach here, the editDialog timeouts.
    return FSM_ERROR;
  }

  /**
   * Simply pause the FSM execution for the given amount of time in ms.
   */
  async s2s_sf_sleep(srcExt, playerID, kwargs, sfInfo) {
    const {delay, nextState} = kwargs;
    await new Promise(resolve => setTimeout(resolve, delay));
    return nextState;
  }

  /**
   * Flip the given variable, assuming it's boolean.
   */
  async s2s_sf_flipBoolVar(srcExt, playerID, kwargs, sfInfo) {
    const varName = kwargs['var'];
    const {trueState, falseState} = kwargs;
    let varVal = await this.helper.varUtils.readVar(varName, playerID, sfInfo.name);
    if (typeof varVal !== "string") {
      console.warn(`Failed to read var '${varName}', assuming it's 0: `, varVal);
      varVal = "0";
    }
    if (varVal === "0") {
      varVal = "1";
    } else if (varVal === "1") {
      varVal = "0";
    } else {
      console.warn(`Invalid varVal '${varVal}' for '${varName}', assuming it's 0`);
      varVal = "1";
    }
    const success = await this.helper.varUtils.writeVar(varName, playerID, sfInfo.name, varVal);
    if (success !== true) {
      console.error(`Failed to write var '${varName}' with varUtil: `, success);
      return FSM_ERROR;
    }

    if (varVal === "1") {
      return trueState;
    } else if (varVal === "0") {
      return falseState;
    }

    console.error('This should not happen in s2s_sf_flipBoolVar');
    return FSM_ERROR;
  }

  /**
   * Allow external party to set a variable for example.
   */
  async e2s_writeVar(varName, val, playerID, objID) {
    // Example for triggering:
    // curl -X POST http://127.0.0.1:5000/e2s/iobj-lib/writeVar \
    // -H 'Content-Type: application/json' \
    // -d '{"apiKey": "secret2", "args": ["@test1", 3, null, null]}'
    return await this.helper.varUtils.writeVar(varName, playerID, objID, val);
  }

  async s2s_sf_testBooleanExpr(srcExt, playerID, kwargs, sfInfo) {
    const {booleanVars, expr, trueState, falseState} = kwargs;
    let thisObj = {};
    for (const varName of booleanVars) {
      let varVal = await this.helper.varUtils.readVar(varName, playerID, sfInfo.name);
      if (typeof varVal !== "string") {
        console.warn(`Failed to read var '${varName}', assuming it's 0: `, varVal);
        varVal = "0";
      }
      if (varVal === "0") {
        varVal = false;
      } else if (varVal === "1") {
        varVal = true;
      } else {
        console.warn(`Invalid boolean varVal '${varVal}' for '${varName}', assuming it's 0`);
        varVal = false;
      }
      thisObj[varName] = varVal;
    }
    let retVal = undefined;
    try {
      const f = new Function(expr);
      retVal = f.call(thisObj);
    } catch (e) {
      console.error(`Invalid function '${expr}' in s2s_sf_testBooleanExpr: `, e, e.stack);
      return FSM_ERROR;
    }
    if (typeof retVal !== 'boolean') {
      console.error(`Function '${expr}' did not return boolean: `, retVal);
      return FSM_ERROR;
    }
    if (retVal === true) {
      return trueState;
    }
    return falseState;
  }
}

export default Standalone;
