import * as babel from '@babel/core';
import type { MastraDeployer } from '@mastra/core';
import { rollup } from 'rollup';
import esbuild from 'rollup-plugin-esbuild';

import { removeAllExceptDeployer } from './babel/get-deployer';
import commonjs from '@rollup/plugin-commonjs';
import { recursiveRemoveNonReferencedNodes } from './plugins/remove-unused-references';

export function getDeployerBundler(entryFile: string, result: { isDeployerRemoved: boolean }) {
  return rollup({
    logLevel: 'silent',
    input: {
      deployer: entryFile,
    },
    treeshake: 'smallest',
    plugins: [
      // transpile typescript to something we understand
      esbuild({
        target: 'node20',
        platform: 'node',
        minify: false,
      }),
      commonjs({
        extensions: ['.js', '.ts'],
        strictRequires: 'strict',
        transformMixedEsModules: true,
        ignoreTryCatch: false,
      }),
      {
        name: 'get-deployer',
        transform(code, id) {
          if (id !== entryFile) {
            return;
          }

          result.isDeployerRemoved = true;
          return new Promise((resolve, reject) => {
            babel.transform(
              code,
              {
                babelrc: false,
                configFile: false,
                filename: id,
                plugins: [removeAllExceptDeployer],
              },
              (err, result) => {
                if (err) {
                  return reject(err);
                }

                resolve({
                  code: result!.code!,
                  map: result!.map!,
                });
              },
            );
          });
        },
      },
      // let esbuild remove all unused imports
      esbuild({
        target: 'node20',
        platform: 'node',
        minify: false,
      }),
      {
        name: 'cleanup-nodes',
        transform(code, id) {
          if (id !== entryFile) {
            return;
          }

          return recursiveRemoveNonReferencedNodes(code);
        },
      },
      // let esbuild remove all unused imports
      esbuild({
        target: 'node20',
        platform: 'node',
        minify: false,
      }),
    ],
  });
}

export async function getDeployer(entryFile: string, outputDir: string) {
  const result: { isDeployerRemoved: boolean } = { isDeployerRemoved: false };
  const bundle = await getDeployerBundler(entryFile, result);

  await bundle.write({
    dir: outputDir,
    format: 'es',
    entryFileNames: '[name].mjs',
  });

  if (!result.isDeployerRemoved) {
    return;
  }

  return (await import(`file:${outputDir}/deployer.mjs`)).deployer as unknown as MastraDeployer;
}
