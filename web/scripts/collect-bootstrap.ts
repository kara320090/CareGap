import {writeFileSync} from 'node:fs';
import {parseDirectory,fetchText,sources} from '../lib/caregap/sources';
(async()=>{const at=new Date().toISOString();const facilities=parseDirectory(await fetchText(sources.directory.url),at);writeFileSync('data/directory-snapshot.json',JSON.stringify({source_url:sources.directory.url,collected_at:at,items:facilities},null,2)+'\n');console.log(JSON.stringify({verified_facilities:facilities.length,source:sources.directory.url,collected_at:at}));})().catch(error=>{console.error(error.message);process.exitCode=1;});
