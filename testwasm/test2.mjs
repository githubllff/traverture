import fs from 'fs';
const wasmBinary = fs.readFileSync('./engine_bg.wasm');
const wasmModule = await import('../engine.js');
await wasmModule.default({ module_or_path: wasmBinary });
const engine = new wasmModule.TravertureEngine('en','en','full',false);
console.log('Luke 1:', engine.parse('en','en','full',false,'Luke 1'));
console.log('Luke 1:1-30:', engine.parse('en','en','full',false,'Luke 1:1-30'));