import './prepare-optional-data.mjs';
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
mkdirSync('.sites-runtime',{recursive:true});
await build({entryPoints:['tests/caregap.test.ts'],bundle:true,platform:'node',format:'cjs',outfile:'.sites-runtime/caregap.test.cjs',external:['node:*'],logLevel:'warning'});
const result=spawnSync(process.execPath,['--test','.sites-runtime/caregap.test.cjs'],{stdio:'inherit'});process.exit(result.status??1);
