/**
 * v2.2.1 / v2.2.2 — WebAuthn enroll + unlock via VS Code webview.
 *
 * Both vscode.dev (browser) and the desktop client (Electron) ship a
 * Chromium-backed webview. `navigator.credentials.create({publicKey})` and
 * `.get()` are implemented natively in both — Electron transparently
 * forwards calls to the OS FIDO2 stack (Windows Hello, Touch ID, hardware
 * keys), while the browser hands them to its own platform authenticator.
 *
 * This module:
 *   1. Spawns a one-shot webview with an HTML page that performs the
 *      WebAuthn ceremony and uses the PRF extension when available.
 *   2. Awaits a `postMessage` reply with `{ ok, credentialIdB64Url, prfB64? }`
 *      or `{ ok: false, reason }`.
 *   3. Disposes the webview either way.
 *
 * The ArrayBuffer↔base64url plumbing lives in the HTML; the host side only
 * has to forward strings. PRF (when supported by the authenticator) yields
 * a 32-byte secret we can feed into HKDF as the KEK material — no
 * round-trip credential id leak required.
 */
import * as vscode from "vscode";

export interface WebAuthnEnrollOptions {
  rpId: string;
  rpName: string;
  userIdB64Url: string;
  userName: string;
  displayName?: string;
  /** Hex of 32-byte challenge. */
  challengeHex: string;
  /** Salt fed into PRF.eval.first; hex 32 bytes. */
  prfSaltHex: string;
}

export interface WebAuthnUnlockOptions {
  rpId: string;
  /** base64url of the credential id we expect to find. */
  credentialIdB64Url: string;
  /** Hex of 32-byte challenge (random per ceremony). */
  challengeHex: string;
  /** Salt fed into PRF.eval.first; hex 32 bytes. */
  prfSaltHex: string;
}

export type WebAuthnResult =
  | { ok: true; credentialIdB64Url: string; prfB64Url?: string; transports?: string[] }
  | { ok: false; reason: string };

const PANEL_VIEW_TYPE = "vscodesync.webauthn";

function buildEnrollHtml(opts: WebAuthnEnrollOptions, nonce: string): string {
  const data = JSON.stringify(opts);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><title>VSCodeSync · Enroll passkey</title><style>body{font-family:system-ui,-apple-system,sans-serif;padding:32px;color:var(--vscode-foreground);background:var(--vscode-editor-background);}button{padding:8px 16px;font-size:14px;}#log{margin-top:16px;font-family:monospace;font-size:12px;white-space:pre-wrap;}</style></head><body><h2>VSCodeSync — Enroll passkey</h2><p>Нажмите кнопку ниже и подтвердите создание passkey биометрией / hardware-ключом. Окно закроется автоматически.</p><button id="go">Создать passkey</button><div id="log"></div><script nonce="${nonce}">(function(){const vscode=acquireVsCodeApi();const opts=${data};const log=document.getElementById('log');function append(s){log.textContent+=s+'\\n';}function hexToBytes(h){const o=new Uint8Array(h.length/2);for(let i=0;i<o.length;i++)o[i]=parseInt(h.slice(i*2,i*2+2),16);return o;}function b64urlEncode(buf){const b=btoa(String.fromCharCode.apply(null,Array.from(new Uint8Array(buf))));return b.replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');}function b64urlDecode(s){const pad=s.length%4===0?'':'='.repeat(4-(s.length%4));const raw=atob(s.replace(/-/g,'+').replace(/_/g,'/')+pad);const o=new Uint8Array(raw.length);for(let i=0;i<o.length;i++)o[i]=raw.charCodeAt(i);return o;}document.getElementById('go').addEventListener('click',async()=>{try{append('navigator.credentials.create(...)');const cred=await navigator.credentials.create({publicKey:{rp:{id:opts.rpId,name:opts.rpName},user:{id:b64urlDecode(opts.userIdB64Url),name:opts.userName,displayName:opts.displayName||opts.userName},challenge:hexToBytes(opts.challengeHex),pubKeyCredParams:[{type:'public-key',alg:-7},{type:'public-key',alg:-257}],authenticatorSelection:{userVerification:'required',residentKey:'preferred'},extensions:{prf:{eval:{first:hexToBytes(opts.prfSaltHex)}}}}});if(!cred){vscode.postMessage({ok:false,reason:'no_credential'});return;}const id=b64urlEncode(cred.rawId);const ext=cred.getClientExtensionResults?cred.getClientExtensionResults():{};let prf;if(ext.prf&&ext.prf.results&&ext.prf.results.first){prf=b64urlEncode(ext.prf.results.first);}const transports=cred.response.getTransports?cred.response.getTransports():undefined;append('done');vscode.postMessage({ok:true,credentialIdB64Url:id,prfB64Url:prf,transports});}catch(e){append('err: '+(e&&e.message?e.message:String(e)));vscode.postMessage({ok:false,reason:e&&e.name?e.name:String(e)});}});})();</script></body></html>`;
}

function buildUnlockHtml(opts: WebAuthnUnlockOptions, nonce: string): string {
  const data = JSON.stringify(opts);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><title>VSCodeSync · Unlock</title><style>body{font-family:system-ui,-apple-system,sans-serif;padding:32px;color:var(--vscode-foreground);background:var(--vscode-editor-background);}button{padding:8px 16px;font-size:14px;}#log{margin-top:16px;font-family:monospace;font-size:12px;white-space:pre-wrap;}</style></head><body><h2>VSCodeSync — Unlock с passkey</h2><p>Нажмите кнопку и подтвердите биометрией / hardware-ключом.</p><button id="go">Разблокировать</button><div id="log"></div><script nonce="${nonce}">(function(){const vscode=acquireVsCodeApi();const opts=${data};const log=document.getElementById('log');function append(s){log.textContent+=s+'\\n';}function hexToBytes(h){const o=new Uint8Array(h.length/2);for(let i=0;i<o.length;i++)o[i]=parseInt(h.slice(i*2,i*2+2),16);return o;}function b64urlEncode(buf){const b=btoa(String.fromCharCode.apply(null,Array.from(new Uint8Array(buf))));return b.replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');}function b64urlDecode(s){const pad=s.length%4===0?'':'='.repeat(4-(s.length%4));const raw=atob(s.replace(/-/g,'+').replace(/_/g,'/')+pad);const o=new Uint8Array(raw.length);for(let i=0;i<o.length;i++)o[i]=raw.charCodeAt(i);return o;}document.getElementById('go').addEventListener('click',async()=>{try{append('navigator.credentials.get(...)');const assn=await navigator.credentials.get({publicKey:{rpId:opts.rpId,allowCredentials:[{type:'public-key',id:b64urlDecode(opts.credentialIdB64Url)}],challenge:hexToBytes(opts.challengeHex),userVerification:'required',extensions:{prf:{eval:{first:hexToBytes(opts.prfSaltHex)}}}}});if(!assn){vscode.postMessage({ok:false,reason:'no_assertion'});return;}const id=b64urlEncode(assn.rawId);const ext=assn.getClientExtensionResults?assn.getClientExtensionResults():{};let prf;if(ext.prf&&ext.prf.results&&ext.prf.results.first){prf=b64urlEncode(ext.prf.results.first);}append('done');vscode.postMessage({ok:true,credentialIdB64Url:id,prfB64Url:prf});}catch(e){append('err: '+(e&&e.message?e.message:String(e)));vscode.postMessage({ok:false,reason:e&&e.name?e.name:String(e)});}});})();</script></body></html>`;
}

function makeNonce(): string {
  let n = "";
  for (let i = 0; i < 16; i++) n += Math.floor(Math.random() * 256).toString(16).padStart(2, "0");
  return n;
}

async function runCeremony(html: string, title: string): Promise<WebAuthnResult> {
  const panel = vscode.window.createWebviewPanel(
    PANEL_VIEW_TYPE,
    title,
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
    { enableScripts: true, retainContextWhenHidden: false },
  );
  panel.webview.html = html;
  return new Promise<WebAuthnResult>((resolve) => {
    let settled = false;
    const sub = panel.webview.onDidReceiveMessage((msg: unknown) => {
      if (settled) return;
      settled = true;
      sub.dispose();
      panel.dispose();
      if (msg && typeof msg === "object" && (msg as { ok?: unknown }).ok === true) {
        const m = msg as { credentialIdB64Url?: string; prfB64Url?: string; transports?: string[] };
        if (typeof m.credentialIdB64Url === "string") {
          resolve({
            ok: true,
            credentialIdB64Url: m.credentialIdB64Url,
            prfB64Url: typeof m.prfB64Url === "string" ? m.prfB64Url : undefined,
            transports: Array.isArray(m.transports) ? m.transports.filter((t): t is string => typeof t === "string") : undefined,
          });
          return;
        }
      }
      const reason = msg && typeof msg === "object" && typeof (msg as { reason?: unknown }).reason === "string"
        ? (msg as { reason: string }).reason
        : "unknown";
      resolve({ ok: false, reason });
    });
    panel.onDidDispose(() => {
      if (settled) return;
      settled = true;
      sub.dispose();
      resolve({ ok: false, reason: "user_dismissed" });
    });
  });
}

export function runWebAuthnEnroll(opts: WebAuthnEnrollOptions): Promise<WebAuthnResult> {
  return runCeremony(buildEnrollHtml(opts, makeNonce()), "VSCodeSync · Enroll passkey");
}

export function runWebAuthnUnlock(opts: WebAuthnUnlockOptions): Promise<WebAuthnResult> {
  return runCeremony(buildUnlockHtml(opts, makeNonce()), "VSCodeSync · Unlock with passkey");
}
