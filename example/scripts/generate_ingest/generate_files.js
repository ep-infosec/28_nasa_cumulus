/* eslint-disable node/no-extraneous-require */
/* eslint-disable no-console */

const fs = require('fs');

const isUndefined = require('lodash/isUndefined');
const { s3PutObject } = require('@cumulus/aws-client/S3');
const { randomStringFromRegex } = require('@cumulus/common/test-utils');

const granuleRegExp = JSON.parse(fs.readFileSync('./sample_collection/MOD09GQ.006.json')).granuleId;

const BATCHSIZE = 100;

// In batches of 100, upload granules
const uploadTestFiles = async (Bucket, path, batches) => {
  console.log(...process.argv.slice(2, 5));
  if (!Number.isFinite(Number(batches)) || batches > 10000) {
    throw new Error(`Invalid batch value ${batches} detected`);
  }

  if (isUndefined(Bucket) || isUndefined(path)) {
    throw new TypeError('Bucket and path must be defined');
  }

  let batchCount = 0;

  console.log(`Running ${batches} batches`);
  while (batchCount < batches) {
    batchCount += 1;
    console.log(`Uploading batch ${batchCount}`);
    const uploadBatchPromises = new Array(BATCHSIZE).fill().map(
      async () => {
        const granString = randomStringFromRegex(granuleRegExp);
        return await Promise.all(['hdf', 'jpg', 'hdf.met'].map((extension) => s3PutObject({
          Bucket,
          Key: `${path}/${granString}.${extension}`,
          Body: 'fake_test_data',
        })));
      }
    );
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(uploadBatchPromises);
    console.log(`Uploaded ${batchCount * BATCHSIZE} / ${BATCHSIZE * batches} granules`);
  }
};

uploadTestFiles(...process.argv.slice(2, 5)).then(
  (result) => {
    console.log(`${result}`);
    return undefined;
  }
).catch((error) => {
  console.dir(error);
  throw error;
});
