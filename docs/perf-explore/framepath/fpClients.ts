// Scratch (idea 131): N viewers in their own process. Usage: node src/fpClients.ts <port> <n> <seconds> [select]
import { WebSocket } from "ws";
const [port, n, secs, sel] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4]), process.argv[5] === "select"];
let bytes = 0, msgs = 0, open = 0;
for (let i = 0; i < n; i++) {
  setTimeout(() => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    let picked = false;
    ws.on("open", () => { open++; });
    ws.on("message", (d: Buffer, bin: boolean) => {
      bytes += d.length; msgs++;
      if (sel && bin && !picked && d[0] === 1 && d.length > 9 + 19) { picked = true; ws.send(JSON.stringify({ t: "select", id: d.readUInt32LE(9 + 19 * (i % 50)) })); }
    });
    ws.on("error", () => {});
    setInterval(() => { try { ws.send("ping"); } catch {} }, 15000).unref();
  }, i * 150);
}
setTimeout(() => { console.log(JSON.stringify({ open, msgs, MB: +(bytes / 1e6).toFixed(1) })); process.exit(0); }, secs * 1000);
