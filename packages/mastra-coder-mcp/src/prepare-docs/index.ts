import { copyRaw } from './copy-raw';
import { organizeDocs } from './organize';

async function main() {
  await copyRaw();
  await organizeDocs();
}

void main();
