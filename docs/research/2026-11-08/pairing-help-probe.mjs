// Browser check for the RouterOS pairing help (#18). Drives a real T3 Code
// server's /pair page with the playwright-core that ships inside the T3
// release archive and a system Chromium; no extra installs.
//
//   PLAYWRIGHT=<t3 dir>/node_modules/playwright-core/index.mjs \
//   CHROMIUM=/usr/bin/chromium \
//   bun docs/research/2026-11-08/pairing-help-probe.mjs <base-url> <token> <screenshot.png>
//
// <token> is a fresh one from `t3 auth pairing create` (or `t3-pairing-link`)
// against the same home. It is passed as an argument and never printed.
const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright-core");
const [base, token, shot] = process.argv.slice(2);
if (!base || !token || !shot) throw new Error("usage: <base-url> <token> <screenshot.png>");

const browser = await chromium.launch({
	executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
	args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
await page.goto(`${base}/pair`);
await page.waitForSelector("#routeros-pairing-help", { timeout: 15000 });
console.log("panel shown before pairing:", await page.isVisible("#routeros-pairing-help"));
const command = await page.textContent("#routeros-pairing-help .rph-cmd code");
console.log("command:", command);

// Manual copy is the only copy path (#30): Tab from the token field must reach
// the command and select all of it, and so must a click.
const selection = () => page.evaluate(() => window.getSelection()?.toString() ?? "");
const onCommand = () => page.evaluate(() => document.activeElement?.matches("#routeros-pairing-help .rph-cmd code") ?? false);
await page.focus("#pairing-token");
let tabs = 0;
while (!(await onCommand()) && tabs < 20) {
	await page.keyboard.press("Tab");
	tabs++;
}
console.log("Tab reaches the command:", await onCommand());
console.log("Tab selects the whole command:", (await selection()) === command);
await page.evaluate(() => window.getSelection()?.removeAllRanges());
await page.focus("#pairing-token");
await page.click("#routeros-pairing-help .rph-cmd code");
console.log("click selects the whole command:", (await selection()) === command);

await page.fill("#pairing-token", "WRONGTOKEN12");
await page.click("button[type=submit]");
await page.waitForSelector("[role=alert]", { timeout: 15000 });
console.log("panels after a rejected token (want 1):", await page.locator("#routeros-pairing-help").count());

await page.fill("#pairing-token", token);
await page.click("button[type=submit]");
await page.waitForFunction(() => !document.getElementById("pairing-token"), null, { timeout: 30000 });
await page.waitForTimeout(1500);
console.log("panels after pairing (want 0):", await page.locator("#routeros-pairing-help").count());
console.log("path after pairing:", new URL(page.url()).pathname);
await page.screenshot({ path: shot });
await browser.close();
