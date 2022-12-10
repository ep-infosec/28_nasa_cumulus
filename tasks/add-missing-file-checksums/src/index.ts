import { runCumulusTask } from '@cumulus/cumulus-message-adapter-js';
import * as awsClients from '@cumulus/aws-client/services';
import * as S3 from '@cumulus/aws-client/S3';
import { Context } from 'aws-lambda';
import { CumulusMessage, CumulusRemoteMessage } from '@cumulus/types/message';
import { Granule, GranuleFile, HandlerInput, HandlerEvent } from './types';

const calculateGranuleFileChecksum = async (params: {
  s3: { getObject: S3.GetObjectMethod },
  algorithm: string,
  granuleFile: GranuleFile
}) => {
  const { s3, algorithm, granuleFile } = params;

  const { bucket, key } = granuleFile;

  return await S3.calculateObjectHash({ s3, algorithm, bucket, key });
};

const granuleFileHasPartialChecksum = (granuleFile: GranuleFile) =>
  (granuleFile.checksumType && !granuleFile.checksum)
  || (granuleFile.checksum && !granuleFile.checksumType);

const granuleFileHasChecksum = (granuleFile: GranuleFile) =>
  granuleFile.checksumType && granuleFile.checksum;

const granuleFileDoesNotHaveBucketAndKey = (granuleFile: GranuleFile) =>
  !granuleFile.bucket || !granuleFile.key;

const skipGranuleFileUpdate = (granuleFile: GranuleFile) =>
  granuleFileHasChecksum(granuleFile)
  || granuleFileHasPartialChecksum(granuleFile)
  || granuleFileDoesNotHaveBucketAndKey(granuleFile);

export const addChecksumToGranuleFile = async (params: {
  s3: { getObject: S3.GetObjectMethod },
  algorithm: string,
  granuleFile: GranuleFile
}) => {
  const { s3, algorithm, granuleFile } = params;

  if (skipGranuleFileUpdate(granuleFile)) {
    return granuleFile;
  }

  const checksum = await calculateGranuleFileChecksum({
    s3,
    algorithm,
    granuleFile,
  });

  return <GranuleFile>{
    ...granuleFile,
    checksumType: algorithm,
    checksum,
  };
};

const addFileChecksumsToGranule = async (params: {
  s3: { getObject: S3.GetObjectMethod },
  algorithm: string,
  granule: Granule
}) => {
  const { s3, granule, algorithm } = params;

  const filesWithChecksums = await Promise.all(
    params.granule.files.map(
      (granuleFile) => addChecksumToGranuleFile({
        s3: s3,
        algorithm,
        granuleFile,
      })
    )
  );

  return {
    ...granule,
    files: filesWithChecksums,
  };
};

export const handler = async (event: HandlerEvent) => {
  const { config, input } = event;
  const granulesWithChecksums = await Promise.all(
    input.granules.map(
      (granule) => addFileChecksumsToGranule({
        s3: awsClients.s3(),
        algorithm: config.algorithm,
        granule,
      })
    )
  );

  return <HandlerInput>{
    ...input,
    granules: granulesWithChecksums,
  };
};

export const cmaHandler = async (
  event: CumulusMessage | CumulusRemoteMessage,
  context: Context
) => await runCumulusTask(handler, event, context);
