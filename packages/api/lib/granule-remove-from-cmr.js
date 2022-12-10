const { GranuleNotPublished } = require('@cumulus/errors');
const { CMR } = require('@cumulus/cmr-client');
const log = require('@cumulus/common/log');
const {
  createRejectableTransaction,
  getGranuleCollectionId,
  GranulePgModel,
} = require('@cumulus/db');
const cmrjsCmrUtils = require('@cumulus/cmrjs/cmr-utils');
const { constructCollectionId } = require('@cumulus/message/Collections');
const models = require('../models');

/**
 * Remove granule record from CMR
 *
 * @param {Object} granule - A postgres granule record
 * @param {string} collectionId - The CMR collection 'id' for the granule to be removed
 * @throws {GranuleNotPublished|Error}
 * @private
 */
const _removeGranuleFromCmr = async (granule, collectionId) => {
  log.info(`granules.removeGranuleFromCmrByGranule granule_id: ${granule.granule_id}, colletion_id: ${collectionId}`);
  if (!granule.published || !granule.cmr_link) {
    throw new GranuleNotPublished(`Granule ${granule.granule_id} in Collection ${collectionId} is not published to CMR, so cannot be removed from CMR`);
  }

  const cmrSettings = await cmrjsCmrUtils.getCmrSettings();
  const cmr = new CMR(cmrSettings);
  const metadata = await cmr.getGranuleMetadata(granule.cmr_link);

  // Use granule UR to delete from CMR
  await cmr.deleteGranule(metadata.title, collectionId);
};

/**
 * Remove granule record from CMR and update Postgres + Dynamo granules
 *
 * @param {Object} params
 * @param {Knex} params.knex - DB client
 * @param {Object} params.pgGranuleRecord - A Postgres granule record
 * @param {string} params.pgCollection - A Postgres Collection record
 * @param {Object} params.granulePgModel - Instance of granules model for PostgreSQL
 * @param {Object} params.granuleDynamoModel - Instance of granules model for DynamoDB
 * @returns {Object} - Updated granules
 * @returns {Object.dynamoGranule} - Updated Dynamo Granule
 * @returns {Object.pgGranule} - Updated Postgres Granule
 */
const unpublishGranule = async ({
  knex,
  pgGranuleRecord,
  pgCollection,
  granulePgModel = new GranulePgModel(),
  granuleDynamoModel = new models.Granule(),
}) => {
  // If we cannot find a Postgres Collection or Postgres Granule,
  // don't update the Postgres Granule, continue to update the Dynamo granule
  const pgGranuleCumulusId = pgGranuleRecord.cumulus_id;
  let dynamoGranuleDeleted = false;
  try {
    return await createRejectableTransaction(knex, async (trx) => {
      const [pgGranule] = await granulePgModel.update(
        trx,
        {
          cumulus_id: pgGranuleCumulusId,
        },
        {
          published: false,
          // using `undefined` would result in Knex ignoring this binding
          // for the update. also, `undefined` is not a valid SQL value, it
          // should be `null` instead
          cmr_link: trx.raw('DEFAULT'),
        },
        ['*']
      );
      const dynamoGranule = await granuleDynamoModel.update(
        { granuleId: pgGranuleRecord.granule_id },
        { published: false },
        ['cmrLink']
      );
      dynamoGranuleDeleted = true;

      let collectionId;

      if (pgCollection) {
        collectionId = constructCollectionId(pgCollection.name, pgCollection.version);
      } else {
        collectionId = await getGranuleCollectionId(knex, pgGranuleRecord);
      }

      await _removeGranuleFromCmr(pgGranuleRecord, collectionId);
      return { dynamoGranule, pgGranule };
    });
  } catch (error) {
    if (dynamoGranuleDeleted) {
      const updateParams = {
        published: pgGranuleRecord.published,
      };
      if (pgGranuleRecord.cmr_link) {
        updateParams.cmrLink = pgGranuleRecord.cmr_link;
      }
      await granuleDynamoModel.update(
        { granuleId: pgGranuleRecord.granule_id },
        updateParams
      );
    }
    throw error;
  }
};

module.exports = {
  unpublishGranule,
};
