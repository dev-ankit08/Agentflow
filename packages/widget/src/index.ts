import { styles } from "./styles";

/**
 * AgentFlow embed widget (docs/02-feature-spec.md §7.1).
 *   <script src="https://api.example.com/widget.js" data-flow="wk_…" async></script>
 * Optional attributes: data-mode="bubble|inline", data-target="#css-selector" (inline), data-api="https://…".
 * JS API: window.AgentFlow.open() / close() / send(text) / identify(token) / on(event, cb)
 */

type Config = { title: string; welcome: string; color: string; quickReplies: string[]; live: boolean };
type Session = { runId: string; sessionToken: string };
type Turn = { role: "user" | "bot"; text: string };
type Citation = { n: number; title: string; uri: string | null };
type FormUi = {
  title: string;
  submitLabel: string;
  fields: { name: string; label: string; type: string; options?: string[]; required: boolean }[];
};
type Listener = (detail: unknown) => void;

const script = document.currentScript as HTMLScriptElement | null;

const store = {
  get<T>(key: string): T | null {
    try {
      return JSON.parse(localStorage.getItem(key) ?? "null") as T | null;
    } catch {
      return null;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Storage blocked (private mode); the conversation lasts for this page only.
    }
  },
  remove(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore
    }
  },
};

/** Escapes HTML, then adds bold, links and line breaks — model output is never inserted as raw HTML. */
function format(text: string): string {
  const escaped = text.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
  return escaped
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(
      /\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)]/g,
      (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
    );
}

/** Reads server-sent events from a fetch response. */
async function* readEvents(res: Response): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (data) yield { event, data: JSON.parse(data) };
    }
    if (done) return;
  }
}

class AgentFlowChat extends HTMLElement {
  private root = this.attachShadow({ mode: "open" });
  private api = "";
  private key = "";
  private mode: "bubble" | "inline" = "bubble";
  private config: Config | null = null;
  private turns: Turn[] = [];
  private identityToken: string | null = null;
  private busy = false;
  private poller: ReturnType<typeof setInterval> | undefined;
  private listeners = new Map<string, Set<Listener>>();
  private els!: {
    panel: HTMLElement;
    messages: HTMLElement;
    chips: HTMLElement;
    input: HTMLTextAreaElement;
    send: HTMLButtonElement;
  };

  configure(api: string, key: string, mode: "bubble" | "inline") {
    this.api = api.replace(/\/$/, "");
    this.key = key;
    this.mode = mode;
  }

  private get storageKey() {
    return `agentflow:${this.key}`;
  }

  async connectedCallback() {
    if (!this.key) {
      this.key = this.getAttribute("flow") ?? "";
      this.api = (this.getAttribute("api") ?? "").replace(/\/$/, "");
      this.mode = this.getAttribute("mode") === "bubble" ? "bubble" : "inline";
    }
    try {
      const res = await fetch(`${this.api}/v1/widget/${encodeURIComponent(this.key)}/config`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
      this.config = await res.json();
    } catch (error) {
      console.warn("[AgentFlow] widget disabled:", (error as Error).message);
      return;
    }
    this.turns = store.get<Turn[]>(`${this.storageKey}:turns`) ?? [];
    this.render();
  }

  private render() {
    const c = this.config!;
    const floating = this.mode === "bubble";
    this.root.innerHTML = `
      <style>${styles(c.color)}</style>
      ${
        floating
          ? `<button class="launcher" part="launcher" aria-label="Open chat" aria-expanded="false">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      </button>`
          : ""
      }
      <section class="panel ${floating ? "floating" : "inline"}" role="dialog" aria-label="" ${floating ? "hidden" : ""}>
        <header><h2></h2>${floating ? `<button class="close" aria-label="Close chat">×</button>` : `<button class="reset" aria-label="Start a new conversation" title="New conversation">↺</button>`}</header>
        <div class="messages" aria-live="polite"></div>
        <div class="chips"></div>
        <form><label style="position:absolute;left:-9999px" for="af-input">Message</label>
          <textarea id="af-input" rows="1" placeholder="Type a message…" maxlength="4000"></textarea>
          <button type="submit">Send</button></form>
        <div class="footer">Powered by AgentFlow</div>
      </section>`;
    const $ = <T extends Element>(s: string) => this.root.querySelector(s) as T;
    this.els = {
      panel: $("section"),
      messages: $(".messages"),
      chips: $(".chips"),
      input: $("textarea"),
      send: $("form button"),
    };
    this.els.panel.setAttribute("aria-label", c.title);
    $<HTMLElement>("h2").textContent = c.title;
    $("form").addEventListener("submit", (e) => {
      e.preventDefault();
      void this.send(this.els.input.value);
    });
    this.els.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.send(this.els.input.value);
      }
    });
    $(".launcher")?.addEventListener("click", () => (this.els.panel.hidden ? this.open() : this.close()));
    $(".close")?.addEventListener("click", () => this.close());
    $(".reset")?.addEventListener("click", () => this.reset());
    this.renderMessages();
  }

  private renderMessages() {
    const { messages, chips } = this.els;
    messages.innerHTML = "";
    if (this.config!.welcome) this.bubble("bot", this.config!.welcome);
    for (const t of this.turns) this.bubble(t.role, t.text);
    chips.innerHTML = "";
    if (this.turns.length === 0) {
      for (const q of this.config!.quickReplies) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = q;
        b.addEventListener("click", () => void this.send(q));
        chips.append(b);
      }
    }
    if (!this.config!.live) this.bubble("error", "This assistant is not published yet.");
  }

  private bubble(kind: "user" | "bot" | "error" | "typing", text: string) {
    const div = document.createElement("div");
    div.className = `msg ${kind === "typing" ? "bot typing" : kind}`;
    div.innerHTML = format(text);
    this.els.messages.append(div);
    this.els.messages.scrollTop = this.els.messages.scrollHeight;
    return div;
  }

  open() {
    if (!this.els) return;
    this.els.panel.hidden = false;
    this.root.querySelector(".launcher")?.setAttribute("aria-expanded", "true");
    this.els.input.focus();
    this.emit("open", null);
  }

  close() {
    if (!this.els || this.mode !== "bubble") return;
    this.els.panel.hidden = true;
    this.root.querySelector(".launcher")?.setAttribute("aria-expanded", "false");
    this.emit("close", null);
  }

  reset() {
    store.remove(`${this.storageKey}:session`);
    store.remove(`${this.storageKey}:turns`);
    this.turns = [];
    if (this.poller) clearInterval(this.poller);
    this.poller = undefined;
    if (this.els) this.renderMessages();
  }

  identify(token: string) {
    this.identityToken = token;
  }

  on(event: string, cb: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(cb);
  }

  private emit(event: string, detail: unknown) {
    this.listeners.get(event)?.forEach((cb) => cb(detail));
    this.dispatchEvent(new CustomEvent(`agentflow:${event}`, { detail, bubbles: true, composed: true }));
  }

  private sessionUrl(session: Session, suffix = "") {
    return `${this.api}/v1/widget/${encodeURIComponent(this.key)}/sessions/${session.runId}${suffix}`;
  }

  /** Numbered sources under a reply, from Knowledge nodes. */
  private addCitations(div: HTMLElement, citations: Citation[]) {
    const list = document.createElement("ol");
    list.className = "cites";
    for (const c of citations) {
      const li = document.createElement("li");
      if (c.uri && /^https?:\/\//.test(c.uri)) {
        const a = document.createElement("a");
        a.href = c.uri;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = c.title;
        li.append(`[${c.n}] `, a);
      } else li.textContent = `[${c.n}] ${c.title}`;
      list.append(li);
    }
    div.append(list);
  }

  /** Thumbs up/down under the latest reply, feeding the ROI dashboard's satisfaction score. */
  private addFeedback(div: HTMLElement) {
    const session = store.get<Session>(`${this.storageKey}:session`);
    if (!session) return;
    this.root.querySelectorAll(".feedback").forEach((el) => el.remove());
    const bar = document.createElement("div");
    bar.className = "feedback";
    for (const [rating, label] of [
      [5, "👍"],
      [1, "👎"],
    ] as const) {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.setAttribute("aria-label", rating === 5 ? "Helpful" : "Not helpful");
      b.addEventListener("click", async () => {
        bar.textContent = "Thanks for the feedback!";
        await fetch(this.sessionUrl(session, "/feedback"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionToken: session.sessionToken, rating }),
        }).catch(() => {});
      });
      bar.append(b);
    }
    div.after(bar);
  }

  /** Renders a Form node; submitting sends the values as the next message. */
  private showForm(ui: FormUi) {
    const form = document.createElement("form");
    form.className = "af-form";
    const title = document.createElement("p");
    title.textContent = ui.title;
    form.append(title);
    for (const f of ui.fields) {
      const label = document.createElement("label");
      label.textContent = f.label + (f.required ? " *" : "");
      let input: HTMLInputElement | HTMLSelectElement;
      if (f.type === "select") {
        input = document.createElement("select");
        for (const o of f.options ?? []) input.append(new Option(o, o));
      } else {
        input = document.createElement("input");
        input.type = f.type === "number" ? "number" : f.type === "email" ? "email" : "text";
      }
      input.name = f.name;
      input.required = f.required;
      label.append(input);
      form.append(label);
    }
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = ui.submitLabel;
    form.append(submit);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const values = Object.fromEntries(new FormData(form).entries()) as Record<string, string>;
      form.remove();
      void this.send(JSON.stringify(values), Object.values(values).join(", "));
    });
    this.els.messages.append(form);
    this.els.messages.scrollTop = this.els.messages.scrollHeight;
  }

  /** While a team member reviews a request, check for the reply every few seconds. */
  private waitForApproval() {
    if (this.poller) return;
    const session = store.get<Session>(`${this.storageKey}:session`);
    if (!session) return;
    const known = this.turns.length;
    this.poller = setInterval(async () => {
      const res = await fetch(
        `${this.sessionUrl(session)}?sessionToken=${encodeURIComponent(session.sessionToken)}`,
      ).catch(() => null);
      if (!res?.ok) return;
      const state = (await res.json()) as {
        status: string;
        messages: { role: string; content: string }[];
        form: FormUi | null;
      };
      if (state.status === "waiting_approval") return;
      clearInterval(this.poller);
      this.poller = undefined;
      for (const m of state.messages.slice(known).filter((m) => m.role === "assistant")) {
        this.turns.push({ role: "bot", text: m.content });
        this.addFeedback(this.bubble("bot", m.content));
        this.emit("message", { content: m.content });
      }
      if (state.form) this.showForm(state.form);
      store.set(`${this.storageKey}:turns`, this.turns.slice(-50));
    }, 4000);
  }

  async send(raw: string, display?: string) {
    const text = raw.trim();
    if (!text || this.busy || !this.config?.live) return;
    this.busy = true;
    this.els.send.disabled = true;
    this.els.input.value = "";
    this.els.chips.innerHTML = "";
    this.root.querySelectorAll(".af-form").forEach((el) => el.remove());
    this.turns.push({ role: "user", text: display ?? text });
    this.bubble("user", display ?? text);
    const typing = this.bubble("typing", "…");
    let draft = "";

    const session = store.get<Session>(`${this.storageKey}:session`);
    const base = `${this.api}/v1/widget/${encodeURIComponent(this.key)}/sessions`;
    try {
      let res = await fetch(session ? `${base}/${session.runId}/messages` : base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          session
            ? { message: text, sessionToken: session.sessionToken }
            : { message: text, identityToken: this.identityToken ?? undefined },
        ),
      });
      if (session && (res.status === 404 || res.status === 409 || res.status === 403)) {
        // The old conversation ended or expired: start a new one with this message.
        store.remove(`${this.storageKey}:session`);
        res = await fetch(base, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ message: text, identityToken: this.identityToken ?? undefined }),
        });
      }
      if (res.status === 423) {
        // A team member is still reviewing an earlier request.
        typing.className = "msg bot";
        typing.innerHTML = format((await res.json().catch(() => ({}))).error ?? "Please wait a moment.");
        this.turns.pop();
        this.waitForApproval();
        return;
      }
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error ?? "Something went wrong");

      let last: HTMLElement | null = null;
      for await (const { event, data } of readEvents(res)) {
        if (event === "session") store.set(`${this.storageKey}:session`, data);
        else if (data.type === "token") {
          draft += String(data.text);
          typing.innerHTML = format(draft);
          this.els.messages.scrollTop = this.els.messages.scrollHeight;
        } else if (data.type === "message") {
          const content = String(data.content);
          // A run can send several messages (e.g. an approval's "please wait"); later ones get their own bubble.
          const target: HTMLElement = last ? this.bubble("bot", "") : typing;
          target.className = "msg bot";
          target.innerHTML = format(content);
          if (Array.isArray(data.citations) && data.citations.length)
            this.addCitations(target, data.citations as Citation[]);
          last = target;
          this.turns.push({ role: "bot", text: content });
          this.emit("message", { content });
        } else if (data.type === "paused") {
          if (data.reason === "form") this.showForm(data.ui as FormUi);
          else this.waitForApproval();
        } else if (data.type === "error") {
          throw new Error(String(data.message));
        }
      }
      if (typing.classList.contains("typing")) typing.remove();
      if (last && !this.poller) this.addFeedback(last);
    } catch (error) {
      typing.remove();
      this.bubble("error", (error as Error).message || "Something went wrong. Please try again.");
    } finally {
      store.set(`${this.storageKey}:turns`, this.turns.slice(-50));
      this.busy = false;
      this.els.send.disabled = false;
      this.els.input.focus();
    }
  }
}

if (!customElements.get("agentflow-chat")) customElements.define("agentflow-chat", AgentFlowChat);

// Auto-mount from the <script data-flow="…"> tag.
if (script?.dataset.flow) {
  const api = script.dataset.api ?? new URL(script.src).origin;
  const mode = script.dataset.mode === "inline" ? "inline" : "bubble";
  const el = document.createElement("agentflow-chat") as AgentFlowChat;
  el.configure(api, script.dataset.flow, mode);
  const mount = () => {
    const target = mode === "inline" && script.dataset.target ? document.querySelector(script.dataset.target) : null;
    (target ?? document.body).append(el);
  };
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
  (window as unknown as { AgentFlow: unknown }).AgentFlow = {
    open: () => el.open(),
    close: () => el.close(),
    send: (text: string) => el.send(text),
    identify: (token: string) => el.identify(token),
    reset: () => el.reset(),
    on: (event: string, cb: Listener) => el.on(event, cb),
  };
}
