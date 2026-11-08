// routeros-pairing.js: RouterOS pairing help on T3 Code's pairing screen (#18).
//
// The image adds one <script> tag for this file to the upstream client's
// index.html (Dockerfile); nothing else in the upstream web build changes.
// When T3's token form (#pairing-token) is on screen, this adds a panel
// after the form with the RouterOS command that prints a fresh token. It
// adds and removes only its own node and never touches React's nodes. If an
// upstream release renames the input, the panel just stops appearing; the
// pairing screen itself is unaffected.
//
// Keep COMMAND in step with README.md "Pairing with the web UI" (a test
// checks both).
(() => {
	const COMMAND = ':put [/container/shell app-t3code cmd="t3-pairing-link" as-value]';
	const PANEL_ID = "routeros-pairing-help";

	const css = `
#${PANEL_ID}{margin-top:24px;padding:12px;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:8px;font-size:13px;line-height:20px}
#${PANEL_ID} h2{margin:0 0 4px;font-size:14px;font-weight:600}
#${PANEL_ID} p{margin:4px 0;opacity:.8}
#${PANEL_ID} .rph-cmd{display:flex;align-items:center;gap:8px;margin:8px 0;padding:4px 4px 4px 10px;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:6px}
#${PANEL_ID} code{font-family:ui-monospace,SF Mono,Menlo,Consolas,monospace;font-size:12px}
#${PANEL_ID} .rph-cmd code{flex:1;min-width:0;overflow-wrap:break-word;user-select:all}
#${PANEL_ID} button{flex:none;height:26px;padding:0 10px;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}
#${PANEL_ID} button:hover{background:color-mix(in srgb,currentColor 8%,transparent)}`;

	function el(tag, text) {
		const node = document.createElement(tag);
		if (text) node.textContent = text;
		return node;
	}

	// A paragraph from strings and nodes; strings stay text (never HTML).
	function para(...parts) {
		const node = el("p");
		node.append(...parts);
		return node;
	}

	function copy(button) {
		const done = (label) => {
			button.textContent = label;
			setTimeout(() => {
				button.textContent = "Copy";
			}, 1500);
		};
		// navigator.clipboard needs a secure context; plain-HTTP installs
		// (use-https=no) fall back to selecting the text for a manual copy.
		if (navigator.clipboard && window.isSecureContext) {
			navigator.clipboard.writeText(COMMAND).then(
				() => done("Copied"),
				() => done("Select + copy"),
			);
			return;
		}
		const code = button.parentElement?.querySelector("code");
		if (code) window.getSelection()?.selectAllChildren(code);
		done("Selected");
	}

	function buildPanel() {
		const panel = el("section");
		panel.id = PANEL_ID;
		panel.setAttribute("aria-label", "Get a pairing token from RouterOS");
		const style = el("style", css);
		panel.append(
			style,
			el("h2", "Running on MikroTik RouterOS?"),
			el("p", "Open a RouterOS terminal (WinBox, WebFig or SSH) and run:"),
		);
		const row = el("div");
		row.className = "rph-cmd";
		const button = el("button", "Copy");
		button.type = "button";
		button.addEventListener("click", () => copy(button));
		row.append(el("code", COMMAND), button);
		panel.append(
			row,
			para(
				"Paste the value after ",
				el("code", "Token:"),
				" into the Pairing token field above. A token expires after about five minutes; run the command again for a new one.",
			),
			para("Renamed the app? Use its container name in place of ", el("code", "app-t3code"), " (see ", el("code", "/container/print"), ")."),
		);
		return panel;
	}

	let scheduled = false;
	function sync() {
		scheduled = false;
		const input = document.getElementById("pairing-token");
		const existing = document.getElementById(PANEL_ID);
		if (!input) {
			existing?.remove();
			return;
		}
		const form = input.closest("form");
		if (!form) return;
		if (existing && existing.previousElementSibling === form) return;
		existing?.remove();
		form.after(buildPanel());
	}

	function schedule() {
		if (scheduled) return;
		scheduled = true;
		requestAnimationFrame(sync);
	}

	function start() {
		new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
		schedule();
	}

	if (document.body) start();
	else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
