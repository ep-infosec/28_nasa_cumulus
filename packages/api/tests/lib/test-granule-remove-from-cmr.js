'use strict';

const test = require('ava');
const sinon = require('sinon');
const omit = require('lodash/omit');
const cryptoRandomString = require('crypto-random-string');

const awsServices = require('@cumulus/aws-client/services');
const launchpad = require('@cumulus/launchpad-auth');
const { constructCollectionId } = require('@cumulus/message/Collections');
const { randomString } = require('@cumulus/common/test-utils');
const { CMR } = require('@cumulus/cmr-client');
const { DefaultProvider } = require('@cumulus/common/key-pair-provider');
const {
  generateLocalTestDb,
  destroyLocalTestDb,
  localStackConnectionEnv,
  CollectionPgModel,
  GranulePgModel,
  translateApiGranuleToPostgresGranule,
  fakeCollectionRecordFactory,
  migrationDir,
} = require('@cumulus/db');

const Granule = require('../../models/granules');
const { fakeGranuleFactoryV2 } = require('../../lib/testUtils');
const { unpublishGranule } = require('../../lib/granule-remove-from-cmr');

const testDbName = `granule_remove_cmr_${cryptoRandomString({ length: 10 })}`;

const createGranuleInDynamoAndPG = async (t, params) => {
  const collectionId = constructCollectionId(
    t.context.fakeCollection.name,
    t.context.fakeCollection.version
  );

  const granule = fakeGranuleFactoryV2({
    collectionId,
    ...params,
  });
  const originalDynamoGranule = await t.context.granulesModel.create(granule);

  const translatedGranule = await translateApiGranuleToPostgresGranule({
    dynamoRecord: granule,
    knexOrTransaction: t.context.knex,
  });
  const [pgGranule] = await t.context.granulePgModel.create(
    t.context.knex,
    translatedGranule
  );
  const pgGranuleCumulusId = pgGranule.cumulus_id;
  const originalPgGranule = await t.context.granulePgModel.get(
    t.context.knex,
    { cumulus_id: pgGranuleCumulusId }
  );
  return {
    originalDynamoGranule,
    originalPgGranule,
    pgGranuleCumulusId,
    collectionId,
  };
};

test.before(async (t) => {
  process.env = {
    ...process.env,
    ...localStackConnectionEnv,
    PG_DATABASE: testDbName,
  };

  process.env.GranulesTable = randomString();
  t.context.granulesModel = new Granule();
  await t.context.granulesModel.createTable();

  t.context.collectionPgModel = new CollectionPgModel();
  t.context.granulePgModel = new GranulePgModel();

  // Store the CMR password
  process.env.cmr_password_secret_name = randomString();
  await awsServices.secretsManager().createSecret({
    Name: process.env.cmr_password_secret_name,
    SecretString: randomString(),
  }).promise();

  // Store the launchpad passphrase
  process.env.launchpad_passphrase_secret_name = randomString();
  await awsServices.secretsManager().createSecret({
    Name: process.env.launchpad_passphrase_secret_name,
    SecretString: randomString(),
  }).promise();

  const { knex, knexAdmin } = await generateLocalTestDb(testDbName, migrationDir);
  t.context.knex = knex;
  t.context.knexAdmin = knexAdmin;

  t.context.fakeCollection = fakeCollectionRecordFactory();
  await t.context.collectionPgModel.create(t.context.knex, t.context.fakeCollection);
});

test.after.always(async (t) => {
  await awsServices.secretsManager().deleteSecret({
    SecretId: process.env.cmr_password_secret_name,
    ForceDeleteWithoutRecovery: true,
  }).promise();
  await awsServices.secretsManager().deleteSecret({
    SecretId: process.env.launchpad_passphrase_secret_name,
    ForceDeleteWithoutRecovery: true,
  }).promise();
  await t.context.granulesModel.deleteTable();
  await destroyLocalTestDb({
    ...t.context,
    testDbName,
  });
});

test('unpublishGranule() removing a granule from CMR fails if the granule is not in CMR', async (t) => {
  const {
    originalDynamoGranule,
    originalPgGranule,
    pgGranuleCumulusId,
    collectionId,
  } = await createGranuleInDynamoAndPG(t, {
    published: false,
    cmrLink: undefined,
  });
  try {
    await unpublishGranule({ knex: t.context.knex, pgGranuleRecord: originalPgGranule });
  } catch (error) {
    t.is(error.message, `Granule ${originalPgGranule.granule_id} in Collection ${collectionId} is not published to CMR, so cannot be removed from CMR`);
  }

  t.like(
    await t.context.granulesModel.get({ granuleId: originalDynamoGranule.granuleId }),
    {
      published: false,
      cmrLink: undefined,
    }
  );

  t.like(
    await t.context.granulePgModel.get(t.context.knex, { cumulus_id: pgGranuleCumulusId }),
    {
      published: false,
      cmr_link: null,
    }
  );
});

test.serial('unpublishGranule() succeeds with Dynamo and PG granule', async (t) => {
  const { fakeCollection } = t.context;

  const {
    originalDynamoGranule,
    originalPgGranule,
    pgGranuleCumulusId,
  } = await createGranuleInDynamoAndPG(t, {
    published: true,
    collectionId: constructCollectionId(fakeCollection.name, fakeCollection.version),
  });

  t.like(
    await t.context.granulesModel.get({ granuleId: originalDynamoGranule.granuleId }),
    {
      published: true,
      cmrLink: originalDynamoGranule.cmrLink,
    }
  );

  t.like(
    await t.context.granulePgModel.get(t.context.knex, {
      cumulus_id: pgGranuleCumulusId,
    }),
    {
      published: true,
      cmr_link: originalPgGranule.cmr_link,
    }
  );

  const cmrMetadataStub = sinon.stub(CMR.prototype, 'getGranuleMetadata').resolves({
    foo: 'bar',
  });
  const cmrDeleteStub = sinon.stub(CMR.prototype, 'deleteGranule').resolves();
  t.teardown(() => {
    cmrMetadataStub.restore();
    cmrDeleteStub.restore();
  });

  const {
    dynamoGranule,
    pgGranule,
  } = await unpublishGranule({ knex: t.context.knex, pgGranuleRecord: originalPgGranule });

  t.true(cmrDeleteStub.called);
  t.deepEqual(
    dynamoGranule,
    omit(
      {
        ...originalDynamoGranule,
        published: false,
        updatedAt: dynamoGranule.updatedAt,
      },
      'cmrLink'
    )
  );
  t.deepEqual(
    pgGranule,
    {
      ...pgGranule,
      published: false,
      cmr_link: null,
    }
  );
});

test.serial('unpublishGranule() accepts an optional collection', async (t) => {
  const { fakeCollection } = t.context;

  const {
    originalDynamoGranule,
    originalPgGranule,
    pgGranuleCumulusId,
  } = await createGranuleInDynamoAndPG(t, {
    published: true,
    collectionId: constructCollectionId(fakeCollection.name, fakeCollection.version),
  });

  t.like(
    await t.context.granulesModel.get({ granuleId: originalDynamoGranule.granuleId }),
    {
      published: true,
      cmrLink: originalDynamoGranule.cmrLink,
    }
  );

  t.like(
    await t.context.granulePgModel.get(t.context.knex, {
      cumulus_id: pgGranuleCumulusId,
    }),
    {
      published: true,
      cmr_link: originalPgGranule.cmr_link,
    }
  );

  const metadataTitle = 'title_string';
  const cmrMetadataStub = sinon.stub(CMR.prototype, 'getGranuleMetadata').resolves({
    title: metadataTitle,
  });
  const cmrDeleteStub = sinon.stub(CMR.prototype, 'deleteGranule').resolves();
  t.teardown(() => {
    cmrMetadataStub.restore();
    cmrDeleteStub.restore();
  });

  const {
    dynamoGranule,
    pgGranule,
  } = await unpublishGranule({
    knex: t.context.knex,
    pgGranuleRecord: originalPgGranule,
    pgCollection: fakeCollection,
  });

  t.is(cmrDeleteStub.calledOnceWith(
    metadataTitle,
    constructCollectionId(fakeCollection.name, fakeCollection.version)
  ), true);

  t.deepEqual(
    dynamoGranule,
    omit(
      {
        ...originalDynamoGranule,
        published: false,
        updatedAt: dynamoGranule.updatedAt,
      },
      'cmrLink'
    )
  );
  t.deepEqual(
    pgGranule,
    {
      ...pgGranule,
      published: false,
      cmr_link: null,
    }
  );
});

test.serial('unpublishGranule() does not update granule CMR status or delete from CMR if PG write fails', async (t) => {
  const {
    originalDynamoGranule,
    originalPgGranule,
    pgGranuleCumulusId,
  } = await createGranuleInDynamoAndPG(t, {
    published: true,
  });

  t.like(
    await t.context.granulesModel.get({ granuleId: originalDynamoGranule.granuleId }),
    {
      published: true,
      cmrLink: originalDynamoGranule.cmrLink,
    }
  );

  t.like(
    await t.context.granulePgModel.get(t.context.knex, {
      cumulus_id: pgGranuleCumulusId,
    }),
    {
      published: true,
      cmr_link: originalPgGranule.cmr_link,
    }
  );

  const cmrMetadataStub = sinon.stub(CMR.prototype, 'getGranuleMetadata').resolves({
    foo: 'bar',
  });
  const cmrDeleteStub = sinon.stub(CMR.prototype, 'deleteGranule').resolves();
  t.teardown(() => {
    cmrMetadataStub.restore();
    cmrDeleteStub.restore();
  });

  const fakeGranulePgModel = {
    getRecordCumulusId: () => Promise.resolve(pgGranuleCumulusId),
    update: () => {
      throw new Error('PG error');
    },
  };

  await t.throwsAsync(
    unpublishGranule({
      knex: t.context.knex,
      pgGranuleRecord: originalPgGranule,
      granulePgModel: fakeGranulePgModel,
    })
  );

  t.false(cmrDeleteStub.called);
  t.like(
    await t.context.granulesModel.get({ granuleId: originalDynamoGranule.granuleId }),
    {
      published: true,
      cmrLink: originalDynamoGranule.cmrLink,
    }
  );
  t.like(
    await t.context.granulePgModel.get(t.context.knex, {
      cumulus_id: pgGranuleCumulusId,
    }),
    {
      published: true,
      cmr_link: originalPgGranule.cmr_link,
    }
  );
});

test.serial('unpublishGranule() does not update granule CMR status or delete from CMR if Dynamo write fails', async (t) => {
  const {
    originalDynamoGranule,
    originalPgGranule,
    pgGranuleCumulusId,
  } = await createGranuleInDynamoAndPG(t, {
    published: true,
  });

  t.like(
    await t.context.granulesModel.get({ granuleId: originalDynamoGranule.granuleId }),
    {
      published: true,
      cmrLink: originalDynamoGranule.cmrLink,
    }
  );

  t.like(
    await t.context.granulePgModel.get(t.context.knex, {
      cumulus_id: pgGranuleCumulusId,
    }),
    {
      published: true,
      cmr_link: originalPgGranule.cmr_link,
    }
  );

  const cmrMetadataStub = sinon.stub(CMR.prototype, 'getGranuleMetadata').resolves({
    foo: 'bar',
  });
  const cmrDeleteStub = sinon.stub(CMR.prototype, 'deleteGranule').resolves();
  t.teardown(() => {
    cmrMetadataStub.restore();
    cmrDeleteStub.restore();
  });

  const fakeGranuleDynamoModel = {
    update: () => {
      throw new Error('Dynamo error');
    },
  };

  await t.throwsAsync(
    unpublishGranule({
      knex: t.context.knex,
      pgGranuleRecord: originalPgGranule,
      granulePgModel: t.context.granulePgModel,
      granuleDynamoModel: fakeGranuleDynamoModel,
    })
  );

  t.false(cmrDeleteStub.called);
  t.like(
    await t.context.granulesModel.get({ granuleId: originalDynamoGranule.granuleId }),
    {
      published: true,
      cmrLink: originalDynamoGranule.cmrLink,
    }
  );
  t.like(
    await t.context.granulePgModel.get(t.context.knex, {
      cumulus_id: pgGranuleCumulusId,
    }),
    {
      published: true,
      cmr_link: originalPgGranule.cmr_link,
    }
  );
});

test.serial('unpublishGranule() does not update granule CMR status if CMR removal fails', async (t) => {
  const {
    originalDynamoGranule,
    originalPgGranule,
    pgGranuleCumulusId,
  } = await createGranuleInDynamoAndPG(t, {
    published: true,
  });

  const cmrMetadataStub = sinon.stub(CMR.prototype, 'getGranuleMetadata').resolves({
    title: 'bar',
  });
  const deleteError = new Error('CMR delete error');
  const cmrDeleteStub = sinon.stub(CMR.prototype, 'deleteGranule').throws(deleteError);
  t.teardown(() => {
    cmrMetadataStub.restore();
    cmrDeleteStub.restore();
  });

  t.like(
    await t.context.granulesModel.get({ granuleId: originalDynamoGranule.granuleId }),
    {
      published: true,
      cmrLink: originalDynamoGranule.cmrLink,
    }
  );

  t.like(
    await t.context.granulePgModel.get(t.context.knex, {
      cumulus_id: pgGranuleCumulusId,
    }),
    {
      published: true,
      cmr_link: originalPgGranule.cmr_link,
    }
  );

  await t.throwsAsync(
    unpublishGranule({
      knex: t.context.knex,
      pgGranuleRecord: originalPgGranule,
    }),
    { message: 'CMR delete error' }
  );

  t.true(cmrDeleteStub.called);
  t.like(
    await t.context.granulesModel.get({ granuleId: originalDynamoGranule.granuleId }),
    {
      published: true,
      cmrLink: originalDynamoGranule.cmrLink,
    }
  );
  t.like(
    await t.context.granulePgModel.get(t.context.knex, {
      cumulus_id: pgGranuleCumulusId,
    }),
    {
      published: true,
      cmr_link: originalPgGranule.cmr_link,
    }
  );
});

test.serial('removing a granule from CMR passes the granule UR to the cmr delete function', async (t) => {
  const {
    originalPgGranule,
  } = await createGranuleInDynamoAndPG(t, {
    published: true,
  });

  sinon.stub(
    DefaultProvider,
    'decrypt'
  ).callsFake(() => Promise.resolve('fakePassword'));

  sinon.stub(
    CMR.prototype,
    'deleteGranule'
  ).callsFake((granuleUr) => Promise.resolve(t.is(granuleUr, 'granule-ur')));

  sinon.stub(
    CMR.prototype,
    'getGranuleMetadata'
  ).callsFake(() => Promise.resolve({ title: 'granule-ur' }));

  try {
    await unpublishGranule({ knex: t.context.knex, pgGranuleRecord: originalPgGranule });
  } finally {
    CMR.prototype.deleteGranule.restore();
    DefaultProvider.decrypt.restore();
    CMR.prototype.getGranuleMetadata.restore();
  }
});

test.serial('removing a granule from CMR succeeds with Launchpad authentication', async (t) => {
  const {
    originalPgGranule,
  } = await createGranuleInDynamoAndPG(t, {
    published: true,
  });

  process.env.cmr_oauth_provider = 'launchpad';
  const launchpadStub = sinon.stub(launchpad, 'getLaunchpadToken').callsFake(() => randomString());

  sinon.stub(
    DefaultProvider,
    'decrypt'
  ).callsFake(() => Promise.resolve('fakePassword'));

  sinon.stub(
    CMR.prototype,
    'deleteGranule'
  ).callsFake((granuleUr) => Promise.resolve(t.is(granuleUr, 'granule-ur')));

  sinon.stub(
    CMR.prototype,
    'getGranuleMetadata'
  ).callsFake(() => Promise.resolve({ title: 'granule-ur' }));

  try {
    await unpublishGranule({ knex: t.context.knex, pgGranuleRecord: originalPgGranule });

    t.is(launchpadStub.calledOnce, true);
  } finally {
    process.env.cmr_oauth_provider = 'earthdata';
    launchpadStub.restore();
    CMR.prototype.deleteGranule.restore();
    DefaultProvider.decrypt.restore();
    CMR.prototype.getGranuleMetadata.restore();
  }
});
