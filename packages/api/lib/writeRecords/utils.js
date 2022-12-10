const isEmpty = require('lodash/isEmpty');
const isNil = require('lodash/isNil');
const semver = require('semver');

const { envUtils } = require('@cumulus/common');
const {
  AsyncOperationPgModel,
  CollectionPgModel,
  ExecutionPgModel,
  ProviderPgModel,
} = require('@cumulus/db');
const {
  MissingRequiredEnvVarError,
  RecordDoesNotExist,
} = require('@cumulus/errors');
const Logger = require('@cumulus/logger');
const {
  getMessageCumulusVersion,
} = require('@cumulus/message/Executions');
const {
  getMessageProviderId,
} = require('@cumulus/message/Providers');

const log = new Logger({ sender: '@cumulus/api/lib/writeRecords/utils' });

const isPostRDSDeploymentExecution = (cumulusMessage) => {
  try {
    const minimumSupportedRDSVersion = envUtils.getRequiredEnvVar('RDS_DEPLOYMENT_CUMULUS_VERSION');
    const cumulusVersion = getMessageCumulusVersion(cumulusMessage);
    return cumulusVersion
      ? semver.gte(cumulusVersion, minimumSupportedRDSVersion)
      : false;
  } catch (error) {
    // Throw error to fail lambda if required env var is missing
    if (error instanceof MissingRequiredEnvVarError) {
      throw error;
    }
    // Treat other errors as false
    return false;
  }
};

const isFailedLookupError = (error) => error instanceof RecordDoesNotExist;

const getAsyncOperationCumulusId = async (
  asyncOperationId,
  knex,
  asyncOperationPgModel = new AsyncOperationPgModel()
) => {
  try {
    if (isNil(asyncOperationId)) {
      log.info('There is no async operation ID to lookup on the message, skipping');
      return undefined;
    }
    return await asyncOperationPgModel.getRecordCumulusId(
      knex,
      {
        id: asyncOperationId,
      }
    );
  } catch (error) {
    if (isFailedLookupError(error)) {
      log.info(error.message);
      return undefined;
    }
    throw error;
  }
};

const getParentExecutionCumulusId = async (
  parentExecutionArn,
  knex,
  executionPgModel = new ExecutionPgModel()
) => {
  try {
    if (isNil(parentExecutionArn)) {
      log.info('There is no parent execution ARN to lookup on the message, skipping');
      return undefined;
    }
    return await executionPgModel.getRecordCumulusId(
      knex,
      {
        arn: parentExecutionArn,
      }
    );
  } catch (error) {
    if (isFailedLookupError(error)) {
      log.info(error.message);
      return undefined;
    }
    throw error;
  }
};

const getCollectionCumulusId = async (
  collectionNameVersion,
  knex,
  collectionPgModel = new CollectionPgModel()
) => {
  try {
    if (isNil(collectionNameVersion)) {
      log.info('There is no collection name/version on the message to lookup, skipping');
      return undefined;
    }
    return await collectionPgModel.getRecordCumulusId(
      knex,
      collectionNameVersion
    );
  } catch (error) {
    if (isFailedLookupError(error)) {
      log.info(error.message);
      return undefined;
    }
    throw error;
  }
};

/**
 * Looks up an Provider's cumulus_id by providerId.
 *
 * @param {string} [providerId = ''] - Full url of stepfunction execution
 * @param {Knex} knex - knex Client
 * @param {Object} providerPgModel - Instance of the provider database model
 * @returns {integer} - RDS internal cumulus_id
 */
const getProviderCumulusId = async (
  providerId,
  knex,
  providerPgModel = new ProviderPgModel()
) => await providerPgModel.getRecordCumulusId(
  knex,
  { name: providerId }
);

const getMessageProviderCumulusId = async (
  cumulusMessage,
  knex,
  providerPgModel = new ProviderPgModel()
) => {
  try {
    const providerId = getMessageProviderId(cumulusMessage);
    if (isNil(providerId)) {
      log.info('Could not find provider ID in message, skipping');
      return undefined;
    }
    return await getProviderCumulusId(providerId, knex, providerPgModel);
  } catch (error) {
    if (isFailedLookupError(error)) {
      log.info(error.message);
      return undefined;
    }
    throw error;
  }
};

/**
 * Looks up an Execution's cumulus_id by executionUrl.
 *
 * @param {string} [executionUrl = ''] - Full url of stepfunction execution
 * @param {Knex} knex - knex Client
 * @param {Object} executionPgModel - instance of the exection database model
 * @returns {integer|undefined} - RDS internal cumulus_id
 */
const getExecutionCumulusId = async (
  executionUrl = '',
  knex,
  executionPgModel = new ExecutionPgModel()
) => {
  try {
    if (isEmpty(executionUrl)) {
      log.info('There is no execution URL to lookup, skipping');
      return undefined;
    }
    return await executionPgModel.getRecordCumulusId(
      knex,
      { url: executionUrl }
    );
  } catch (error) {
    if (isFailedLookupError(error)) {
      log.info(error.message);
      return undefined;
    }
    log.error(`Encountered error trying to find ${executionUrl}`, error);
    throw (error);
  }
};

const isStatusFinalState = (status) => status === 'completed' || status === 'failed';

module.exports = {
  isPostRDSDeploymentExecution,
  getAsyncOperationCumulusId,
  getExecutionCumulusId,
  getParentExecutionCumulusId,
  getProviderCumulusId,
  getCollectionCumulusId,
  getMessageProviderCumulusId,
  isStatusFinalState,
};
