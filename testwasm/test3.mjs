import fs from 'fs';
const wasmBinary = fs.readFileSync('inrefens-engine_bg.wasm');
const wasmModule = await import('../inrefens-engine.js');
try {
  await wasmModule.default({ module_or_path: wasmBinary });
  console.log('wasm loaded');
  const engine = new wasmModule.InrefensEngine('en', false, 140233471);
  console.log('engine created');
  console.log(engine.find_citations('w21.5 12'));
} catch (e) {
  console.error('ERROR:', e);
}