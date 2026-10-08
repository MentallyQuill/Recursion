import { readFile, writeFile, mkdir, stat, lstat } from 'node:fs/promises';
import { resolve, relative, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyzePreparationReports } from './lib/preparation-analysis.mjs';

const repositoryRoot=fileURLToPath(new URL('../..',import.meta.url));
export async function runPreparationAnalysis(argv, {workspaceRoot=repositoryRoot} = {}) {
  const inputs=[];
  let output='artifacts/preparation-analysis.json';
  for(let index=0;index<argv.length;index++) {
    if(argv[index] === '--output' && argv[index+1]) output=argv[++index];
    else if(argv[index].startsWith('--')) throw new Error('Use diagnostics JSON paths and optional --output workspace/path.json.');
    else inputs.push(argv[index]);
  }
  if(!inputs.length || inputs.length > 64) throw new Error('Provide 1..64 diagnostics export paths. This command makes no model calls.');
  const root=resolve(workspaceRoot),target=resolve(root,output),rel=relative(root,target);
  if(!rel || rel.startsWith('..'+sep) || rel === '..' || /^[a-z]:/i.test(rel)
    || /^(?:src|styles|assets|\.git)(?:[\\/]|$)/i.test(rel) || /^(?:manifest|package(?:-lock)?)\.json$/i.test(rel)) {
    throw new Error('Analysis output must be a report path inside the workspace, outside production files.');
  }
  let cursor=root;
  for(const part of rel.split(sep)) {
    cursor=resolve(cursor,part);
    try {if((await lstat(cursor)).isSymbolicLink()) throw new Error('Report output cannot traverse a symbolic link.');}
    catch(error) {if(error.code !== 'ENOENT') throw error;}
  }
  const reports=[];
  for(const input of inputs) {
    try {
      const source=resolve(root,input);
      if((await stat(source)).size > 5*1024*1024) throw new Error();
      reports.push(JSON.parse(await readFile(source,'utf8')));
    } catch {throw new Error('Could not read a bounded JSON diagnostics export (maximum 5 MiB per file).');}
  }
  const analysis=analyzePreparationReports(reports);
  await mkdir(dirname(target),{recursive:true});
  await writeFile(target,JSON.stringify(analysis,null,2)+'\n','utf8');
  return {analysis,output:target};
}
if(process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {const result=await runPreparationAnalysis(process.argv.slice(2));console.log(`Analyzed ${result.analysis.operations} operations into ${result.analysis.groups.length} groups: ${result.output}`);}
  catch(error) {console.error(error.message);process.exitCode=1;}
}
