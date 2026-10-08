import { validateSoakUserHandle } from './sillytavern-live-harness.mjs';

export function parseLiveBenchmarkOptions(argv = [], environment = {}) {
  const flags=new Set(['--live','--inspect','--ui','--certify','--resume','--reasoning-off']);
  const values={};
  for(let index=0;index<argv.length;index++) {
    const arg=argv[index];
    if(flags.has(arg)) continue;
    if(!['--profile','--samples','--cards','--reasoning-level'].includes(arg) || values[arg] !== undefined
      || !argv[index+1] || argv[index+1].startsWith('--')) throw new Error('Invalid benchmark arguments.');
    values[arg]=argv[++index];
  }
  if(!argv.includes('--live') || !validateSoakUserHandle(environment.RECURSION_SILLYTAVERN_USER).ok) {
    throw new Error('Use --live with a dedicated RECURSION_SILLYTAVERN_USER (recursion-soak-*). Default User is rejected.');
  }
  const baseUrl=environment.SILLYTAVERN_BASE_URL;
  let address;
  try {address=new URL(baseUrl);} catch {throw new Error('Set SILLYTAVERN_BASE_URL explicitly.');}
  if(!['http:','https:'].includes(address.protocol) || address.username || address.password) throw new Error('Invalid SillyTavern base URL.');
  const profileName=values['--profile'] ?? environment.RECURSION_BENCHMARK_PROFILE;
  if(typeof profileName !== 'string' || !profileName.trim() || profileName.length > 180 || /[\r\n|\x00-\x1f]/.test(profileName)) {
    throw new Error('Select an explicit benchmark connection profile with --profile or RECURSION_BENCHMARK_PROFILE.');
  }
  const rawSamples=values['--samples'] ?? environment.RECURSION_BENCHMARK_SAMPLES;
  if(typeof rawSamples !== 'string' || !/^(?:[1-9]|10)$/.test(rawSamples)) throw new Error('Select --samples 1..10 explicitly.');
  const cards=values['--cards'] ?? '6';
  const reasoningLevel=values['--reasoning-level'] ?? (argv.includes('--reasoning-off') ? 'low' : 'medium');
  if(!['6','9'].includes(cards) || !['low','medium','high'].includes(reasoningLevel)) throw new Error('Use --cards 6 or 9 and --reasoning-level low, medium or high.');
  return Object.freeze({baseUrl,user:environment.RECURSION_SILLYTAVERN_USER,profileName:profileName.trim(),
    samples:Number(rawSamples),cards:Number(cards),reasoningLevel});
}
