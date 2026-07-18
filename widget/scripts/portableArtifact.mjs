import { copyFile, mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';

const PORTABLE_ARTIFACT_PATTERN = /^CPA-Token-Pulse-.+-portable\.exe$/i;

export async function promotePortableArtifact({ builderOutput, deliveryDirectory }) {
  const entries = await readdir(builderOutput, { withFileTypes: true });
  const artifacts = entries.filter(
    (entry) => entry.isFile() && PORTABLE_ARTIFACT_PATTERN.test(entry.name)
  );

  if (artifacts.length !== 1) {
    throw new Error(`portable-artifact-count:${artifacts.length}`);
  }

  await mkdir(deliveryDirectory, { recursive: true });

  const sourcePath = path.join(builderOutput, artifacts[0].name);
  const destinationPath = path.join(deliveryDirectory, artifacts[0].name);
  const temporaryPath = `${destinationPath}.tmp-${process.pid}-${Date.now()}`;

  await copyFile(sourcePath, temporaryPath);
  try {
    await rename(temporaryPath, destinationPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }

  return destinationPath;
}
