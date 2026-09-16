function pad(n: number) { return String(n).padStart(2, '0'); }
function ts(): string {
  const d = new Date();
  return `[${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]`;
}
export const logger = {
  info(name: string, msg: string)  { console.log(`${ts()} [${name}] ${msg}`); },
  warn(name: string, msg: string)  { console.log(`${ts()} [${name}] WARN: ${msg}`); },
  error(name: string, msg: string) { console.error(`${ts()} [ERROR] [${name}] ${msg}`); },
  sys(msg: string)                 { console.log(`${ts()} [system] ${msg}`); },
  sys_error(msg: string)           { console.log(`${ts()} [error] ${msg}`); },
};
