'use strict';

import Logger from '@cumulus/logger';
import { getQueueNameFromUrl, SQSMessage } from '@cumulus/aws-client/SQS';
import { envUtils } from '@cumulus/common';
import { s3PutObject, deleteS3Object } from '@cumulus/aws-client/S3';

const logger = new Logger({ sender: '@cumulus/ingest/sqs' });

export function getS3PrefixForArchivedMessage(stackName:string, queueName: string) {
  const prefix = `${stackName}/archived-incoming-messages/${queueName}/`;
  return prefix;
}

export function getS3KeyForArchivedMessage(
  stackName: string,
  messageId: string,
  queueName: string
) {
  const key = `${getS3PrefixForArchivedMessage(stackName, queueName)}${messageId}`;
  return key;
}

/**
 * Archives incoming SQS Message into S3
 *
 * @param {string} queueUrl - Queue URL
 * @param {Object} message - SQS message
 * @returns {undefined}
 */
export async function archiveSqsMessageToS3(queueUrl:string, message: SQSMessage) {
  const bucket = envUtils.getRequiredEnvVar('system_bucket', process.env);
  const stackName = envUtils.getRequiredEnvVar('stackName', process.env);

  if (!message.MessageId) {
    const error = new Error(`MessageId on message ${JSON.stringify(message)} required but not found.`);
    logger.error(error);
    throw error;
  }

  const queueName = getQueueNameFromUrl(queueUrl);

  if (!queueName) {
    throw new Error(`Unable to determine queueName from ${queueUrl}`);
  }

  const key = getS3KeyForArchivedMessage(stackName, message.MessageId, queueName);
  const body = message.Body;
  logger.info(`Archiving message ${message.MessageId} from queue ${queueUrl}`);
  try {
    await s3PutObject({
      Bucket: bucket,
      Key: key,
      Body: body,
    });
    logger.debug(`Archived ${message.MessageId} from queue with key ${key}`);
  } catch (error) {
    logger.error(`Could not write to bucket. ${error}`);
    throw error;
  }
}

/**
 * Deletes archived SQS Message from S3
 *
 * @param {string} messageId - SQS message ID
 * @param {string} queueUrl  - SQS queue URL
 * @returns {undefined}
 */
export async function deleteArchivedMessageFromS3(messageId: string, queueUrl: string) {
  const bucket = envUtils.getRequiredEnvVar('system_bucket', process.env);
  const stackName = envUtils.getRequiredEnvVar('stackName', process.env);
  const queueName = getQueueNameFromUrl(queueUrl);

  if (!queueName) {
    throw new Error(`Unable to determine queueName from ${queueUrl}`);
  }

  const key = getS3KeyForArchivedMessage(stackName, messageId, queueName);
  try {
    await deleteS3Object(bucket, key);
    logger.info(`Deleted archived message ${messageId} from S3 at ${bucket}/${key}`);
  } catch (error) {
    logger.error(`Could not delete message from bucket. ${error}`);
    throw error;
  }
}
