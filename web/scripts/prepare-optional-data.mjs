import { mkdirSync, writeFileSync } from 'node:fs';

// Site builds use static JSON imports. A fresh checkout starts with no institution records.
function createIfMissing(url, value) {
  try {
    writeFileSync(url, JSON.stringify(value) + '\n', { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}

const data = new URL('../data/', import.meta.url);
mkdirSync(new URL('official-facility-locations/', data), { recursive: true });
createIfMissing(new URL('directory-snapshot.json', data), {
  source_url: 'https://www.1661-2129.or.kr/organization/sub01.php',
  collected_at: '', items: [],
});
createIfMissing(new URL('official-facility-locations/manifest.json', data), {
  source_url: 'https://www.bokjiro.go.kr/ssis-tbu/twatca/wlfcl/wlfclPage.do',
  collected_at: '', raw_records_checked: 0, count: 0, unique_service_ids: true,
  regions: [], chunks: [],
});
