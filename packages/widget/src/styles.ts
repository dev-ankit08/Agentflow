/** Styles live inside the Shadow DOM, so the host page's CSS cannot affect the widget (and vice versa). */
export const styles = (color: string) => `
:host { all: initial; --af-color: ${color}; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: #18181b; }
* { box-sizing: border-box; }
.launcher { position: fixed; right: 20px; bottom: 20px; width: 56px; height: 56px; border-radius: 50%; border: 0; cursor: pointer;
  background: var(--af-color); color: #fff; box-shadow: 0 8px 24px rgba(0,0,0,.18); display: grid; place-items: center; z-index: 2147483000; }
.launcher:focus-visible, button:focus-visible, textarea:focus-visible { outline: 2px solid var(--af-color); outline-offset: 2px; }
.panel { display: flex; flex-direction: column; background: #fff; border: 1px solid #e4e4e7; border-radius: 16px; overflow: hidden;
  box-shadow: 0 16px 48px rgba(0,0,0,.18); }
.panel.floating { position: fixed; right: 20px; bottom: 88px; width: min(380px, calc(100vw - 32px)); height: min(600px, calc(100vh - 120px)); z-index: 2147483000; }
.panel.inline { width: 100%; height: 100%; min-height: 420px; box-shadow: none; }
.panel[hidden] { display: none; }
header { background: var(--af-color); color: #fff; padding: 14px 16px; display: flex; align-items: center; justify-content: space-between; }
header h2 { margin: 0; font-size: 15px; font-weight: 600; }
header button { background: transparent; border: 0; color: #fff; font-size: 20px; line-height: 1; cursor: pointer; padding: 2px 6px; }
.messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 10px; background: #fafafa; }
.msg { max-width: 85%; padding: 9px 12px; border-radius: 14px; font-size: 14px; line-height: 1.45; white-space: pre-wrap; word-wrap: break-word; }
.msg.bot { align-self: flex-start; background: #fff; border: 1px solid #e4e4e7; border-bottom-left-radius: 4px; }
.msg.user { align-self: flex-end; background: var(--af-color); color: #fff; border-bottom-right-radius: 4px; }
.msg.error { align-self: center; background: #fdecec; color: #b42318; font-size: 13px; }
.msg.typing { color: #71717a; }
.msg a { color: inherit; text-decoration: underline; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 16px 8px; background: #fafafa; }
.chips button { border: 1px solid var(--af-color); color: var(--af-color); background: #fff; border-radius: 999px; padding: 5px 10px; font-size: 13px; cursor: pointer; }
form { display: flex; gap: 8px; padding: 10px; border-top: 1px solid #e4e4e7; background: #fff; }
textarea { flex: 1; resize: none; border: 1px solid #e4e4e7; border-radius: 10px; padding: 9px 10px; font: inherit; font-size: 14px; max-height: 120px; }
form button { border: 0; border-radius: 10px; background: var(--af-color); color: #fff; padding: 0 14px; font-size: 14px; cursor: pointer; }
form button:disabled { opacity: .5; cursor: not-allowed; }
.cites { margin: 6px 0 0; padding: 6px 0 0 16px; border-top: 1px solid #e4e4e7; font-size: 11px; color: #71717a; white-space: normal; }
.feedback { align-self: flex-start; display: flex; gap: 4px; font-size: 11px; color: #71717a; margin-top: -4px; }
.feedback button { border: 1px solid #e4e4e7; background: #fff; border-radius: 999px; padding: 2px 8px; cursor: pointer; font-size: 12px; }
.af-form { align-self: flex-start; width: 85%; background: #fff; border: 1px solid var(--af-color); border-radius: 12px; padding: 10px; display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
.af-form p { margin: 0; font-weight: 600; }
.af-form label { display: flex; flex-direction: column; gap: 3px; color: #52525b; font-size: 12px; }
.af-form input, .af-form select { border: 1px solid #e4e4e7; border-radius: 8px; padding: 6px 8px; font: inherit; font-size: 13px; }
.af-form button { align-self: flex-start; border: 0; border-radius: 8px; background: var(--af-color); color: #fff; padding: 6px 12px; cursor: pointer; }
.footer { text-align: center; font-size: 11px; color: #a1a1aa; padding: 0 0 8px; background: #fff; }
`;
