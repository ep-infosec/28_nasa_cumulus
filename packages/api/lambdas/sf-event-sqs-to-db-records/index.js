'use strict';

const get = require('lodash/get');

const { parseSQSMessageBody, sendSQSMessage } = require('@cumulus/aws-client/SQS');

const Logger = require('@cumulus/logger');
const {
  getKnexClient,
} = require('@cumulus/db');
const {
  UnmetRequirementsError,
} = require('@cumulus/errors');
const {
  getMessageAsyncOperationId,
} = require('@cumulus/message/AsyncOperations');
const {
  getCollectionNameAndVersionFromMessage,
} = require('@cumulus/message/Collections');
const {
  getMessageExecutionParentArn,
} = require('@cumulus/message/Executions');
const { getCumulusMessageFromExecutionEvent } = require('@cumulus/message/StepFunctions');

const {
  getCollectionCumulusId,
  getMessageProviderCumulusId,
  isPostRDSDeploymentExecution,
  getAsyncOperationCumulusId,
  getParentExecutionCumulusId,
} = require('../../lib/writeRecords/utils');

const {
  shouldWriteExecutionToPostgres,
  writeExecutionRecordFromMessage,
} = require('../../lib/writeRecords/write-execution');

const {
  writePdr,
} = require('./write-pdr');

const {
  writeGranulesFromMessage,
} = require('../../lib/writeRecords/write-granules');

const log = new Logger({ sender: '@cumulus/api/lambdas/sf-event-sqs-to-db-records' });

/**
 * Write records to data stores. Use conditional logic to write either to
 * DynamoDB only or to DynamoDB and RDS.
 *
 * @param {Object} params
 * @param {Object} params.cumulusMessage - Cumulus workflow message
 * @param {Knex} params.knex - Knex client
 * @param {Object} [params.granuleModel]
 *   Optional instance of granules model used for writing to DynamoDB
 * @param {Object} [params.executionModel]
 *   Optional instance of execution model used for writing to DynamoDB
 * @param {Object} [params.pdrModel]
 *   Optional instance of PDR model used for writing to DynamoDB
 */
const writeRecords = async ({
  cumulusMessage,
  knex,
  granuleModel,
  executionModel,
  pdrModel,
}) => {
  if (!isPostRDSDeploymentExecution(cumulusMessage)) {
    log.info('Message is not for a post-RDS deployment execution.');
  }

  const messageCollectionNameVersion = getCollectionNameAndVersionFromMessage(cumulusMessage);
  const messageAsyncOperationId = getMessageAsyncOperationId(cumulusMessage);
  const messageParentExecutionArn = getMessageExecutionParentArn(cumulusMessage);
  const [
    collectionCumulusId,
    asyncOperationCumulusId,
    parentExecutionCumulusId,
  ] = await Promise.all([
    getCollectionCumulusId(
      messageCollectionNameVersion,
      knex
    ),
    getAsyncOperationCumulusId(
      messageAsyncOperationId,
      knex
    ),
    getParentExecutionCumulusId(
      messageParentExecutionArn,
      knex
    ),
  ]);

  if (!shouldWriteExecutionToPostgres({
    messageCollectionNameVersion,
    collectionCumulusId,
    messageAsyncOperationId,
    asyncOperationCumulusId,
    messageParentExecutionArn,
    parentExecutionCumulusId,
  })) {
    throw new UnmetRequirementsError('Could not satisfy requirements for writing records to PostgreSQL. No records written to the database.');
  }

  const executionCumulusId = await writeExecutionRecordFromMessage({
    cumulusMessage,
    collectionCumulusId,
    asyncOperationCumulusId,
    parentExecutionCumulusId,
    knex,
    executionModel,
  });

  const providerCumulusId = await getMessageProviderCumulusId(cumulusMessage, knex);

  const pdrCumulusId = await writePdr({
    cumulusMessage,
    collectionCumulusId,
    providerCumulusId,
    knex,
    executionCumulusId,
    pdrModel,
  });

  return writeGranulesFromMessage({
    cumulusMessage,
    providerCumulusId,
    executionCumulusId,
    pdrCumulusId,
    knex,
    granuleModel,
  });
};

const handler = async (event) => {
  const knex = await getKnexClient({
    env: {
      ...process.env,
      ...event.env,
    },
  });

  const sqsMessages = get(event, 'Records', []);

  return await Promise.all(sqsMessages.map(async (message) => {
    const executionEvent = parseSQSMessageBody(message);
    const cumulusMessage = await getCumulusMessageFromExecutionEvent(executionEvent);

    try {
      return await writeRecords({ ...event, cumulusMessage, knex });
    } catch (error) {
      log.error(`Writing message failed: ${JSON.stringify(message)}`, error);
      return sendSQSMessage(process.env.DeadLetterQueue, message);
    }
  }));
};

module.exports = {
  handler,
  writeRecords,
};
