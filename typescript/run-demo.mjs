import { DemoRecorderAgent } from './dist/agents/DemoRecorderAgent.js';

const recorder = new DemoRecorderAgent();
console.log('🎬 Starting RAR demo recording...');
console.log('This will take control of Safari — don\'t touch the mouse/keyboard!\n');

const result = await recorder.execute({ action: 'record_rar', output_name: 'rar_walkthrough' });
const parsed = JSON.parse(result);

console.log('\n🎬 Recording complete!');
console.log(`Video: ${parsed.video_path}`);
console.log(`Steps: ${parsed.steps_completed}/${parsed.steps_total}`);
console.log(`Screenshots: ${parsed.screenshots?.length || 0}`);

if (parsed.log) {
  console.log('\nStep log:');
  for (const entry of parsed.log) {
    const icon = entry.status === 'success' ? '✅' : '❌';
    console.log(`  ${icon} ${entry.step}${entry.narration ? ` — "${entry.narration}"` : ''}`);
  }
}
