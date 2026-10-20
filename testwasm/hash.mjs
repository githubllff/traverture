import fs from 'fs';
const mainJsText = fs.readFileSync('C:/Users/Administrator/AppData/Local/Temp/opencode/inrefens/main.js', 'utf8');
const WASM_START = '/*WASM-START*/';
const WASM_END = '/*WASM-END*/';
const wsIdx = mainJsText.indexOf(WASM_START);
const weIdx = mainJsText.indexOf(WASM_END, wsIdx);
const stripped = mainJsText.slice(0, wsIdx) + mainJsText.slice(weIdx + WASM_END.length);
const bytes = new TextEncoder().encode(stripped);
const H_START = 2166136261;
const H_END = 16777619;
let h = H_START;
for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, H_END) >>> 0;
}
console.log('engineId:', h >>> 0);