const test = require('ava');
const sinon = require('sinon');

const { randomString } = require('@cumulus/common/test-utils');
const Lambda = require('@cumulus/aws-client/Lambda');
const { sns } = require('@cumulus/aws-client/services');
const StepFunctions = require('@cumulus/aws-client/StepFunctions');
const { constructCollectionId } = require('@cumulus/message/Collections');
const {
  localStackConnectionEnv,
  generateLocalTestDb,
  destroyLocalTestDb,
  GranulePgModel,
  migrationDir,
  translateApiGranuleToPostgresGranule,
  CollectionPgModel,
  fakeCollectionRecordFactory,
  getUniqueGranuleByGranuleId,
} = require('@cumulus/db');
const {
  createTestIndex,
} = require('@cumulus/es-client/testUtils');
const {
  fakeGranuleFactoryV2,
  fakeCollectionFactory,
} = require('../../lib/testUtils');

const { Granule, Rule } = require('../../models');

const {
  reingestGranule,
  applyWorkflow,
} = require('../../lib/ingest');

const testDbName = randomString(12);
const sandbox = sinon.createSandbox();
const FakeEsClient = sandbox.stub();
const esSearchStub = sandbox.stub();
const esScrollStub = sandbox.stub();
FakeEsClient.prototype.scroll = esScrollStub;
FakeEsClient.prototype.search = esSearchStub;

let fakeExecution;
let testCumulusMessage;

test.before(async (t) => {
  process.env = {
    ...process.env,
    ...localStackConnectionEnv,
    PG_DATABASE: testDbName,
  };

  const { knex, knexAdmin } = await generateLocalTestDb(testDbName, migrationDir);
  t.context.knex = knex;
  t.context.knexAdmin = knexAdmin;
  t.context.granuleId = randomString();

  const { esIndex, esClient } = await createTestIndex();
  t.context.esIndex = esIndex;
  t.context.esClient = esClient;

  process.env.GranulesTable = randomString();
  await new Granule().createTable();

  const { TopicArn } = await sns().createTopic({ Name: randomString() }).promise();
  t.context.granules_sns_topic_arn = TopicArn;
  process.env.granule_sns_topic_arn = t.context.granules_sns_topic_arn;

  testCumulusMessage = {
    cumulus_meta: {
      execution_name: randomString(),
      state_machine: 'arn:aws:states:us-east-1:123456789012:stateMachine:HelloStateMachine',
      workflow_start_time: Date.now(),
    },
    meta: {
      collection: {
        name: randomString(),
        version: randomString(),
      },
      provider: {
        host: randomString(),
        protocol: 's3',
      },
      status: 'completed',
    },
    payload: {
      granules: [
        {
          granuleId: t.context.granuleId,
          sync_granule_duration: 123,
          post_to_cmr_duration: 456,
          files: [],
        },
      ],
    },
  };

  fakeExecution = {
    input: JSON.stringify(testCumulusMessage),
    startDate: new Date(Date.UTC(2019, 6, 28)),
    stopDate: new Date(Date.UTC(2019, 6, 28, 1)),
  };
  sandbox.stub(StepFunctions, 'describeExecution').resolves(fakeExecution);

  // Create collections in Dynamo and Postgres
  // we need this because a granule has a foreign key referring to collections
  const collectionName = 'fakeCollection';
  const collectionVersion = 'v1';

  t.context.testCollection = fakeCollectionFactory({
    name: collectionName,
    version: collectionVersion,
    duplicateHandling: 'error',
  });
  t.context.collectionId = constructCollectionId(
    collectionName,
    collectionVersion
  );

  const testPgCollection = fakeCollectionRecordFactory({
    name: collectionName,
    version: collectionVersion,
  });
  const collectionPgModel = new CollectionPgModel();
  const [pgCollection] = await collectionPgModel.create(
    t.context.knex,
    testPgCollection
  );
  t.context.collectionCumulusId = pgCollection.cumulus_id;
});

test.afterEach.always(() => {
  sandbox.resetHistory();
});

test.after.always(async (t) => {
  sandbox.restore();
  await destroyLocalTestDb({
    knex: t.context.knex,
    knexAdmin: t.context.knexAdmin,
    testDbName,
  });
  await sns().deleteTopic({ TopicArn: t.context.granules_sns_topic_arn }).promise();
});

test.serial('reingestGranule pushes a message with the correct queueUrl', async (t) => {
  const {
    collectionId,
  } = t.context;
  const buildPayloadSpy = sinon.stub(Rule, 'buildPayload');

  const granuleModel = new Granule();
  const granulePgModel = new GranulePgModel();
  const queueUrl = 'testqueueUrl';

  const granule = fakeGranuleFactoryV2({
    collectionId,
  });
  const dynamoGranule = await granuleModel.create(granule);
  await granulePgModel.create(
    t.context.knex,
    await translateApiGranuleToPostgresGranule({
      dynamoRecord: dynamoGranule,
      knexOrTransaction: t.context.knex,
    })
  );

  t.teardown(() => buildPayloadSpy.restore());

  await reingestGranule({
    granule,
    queueUrl,
    granuleModel,
    granulePgModel,
  });
  // Rule.buildPayload has its own unit tests to ensure the queue name
  // is used properly, so just ensure that we pass the correct argument
  // to that function.
  t.is(buildPayloadSpy.args[0][0].queueUrl, queueUrl);

  const updatedPgGranule = await getUniqueGranuleByGranuleId(
    t.context.knex,
    granule.granuleId
  );
  t.is(updatedPgGranule.status, 'queued');
});

test.serial('applyWorkflow throws error if workflow argument is missing', async (t) => {
  const granule = {
    granuleId: randomString(),
  };

  await t.throwsAsync(
    applyWorkflow(granule),
    {
      instanceOf: TypeError,
    }
  );
});

test.serial('applyWorkflow invokes Lambda to schedule workflow', async (t) => {
  const granule = fakeGranuleFactoryV2({
    collectionId: t.context.collectionId,
  });
  const workflow = randomString();
  const lambdaPayload = {
    payload: {
      granules: [granule],
    },
  };

  const buildPayloadStub = sinon.stub(Rule, 'buildPayload').resolves(lambdaPayload);
  const lambdaInvokeStub = sinon.stub(Lambda, 'invoke').resolves();

  await applyWorkflow({ granule, workflow });

  try {
    t.true(lambdaInvokeStub.called);
    t.deepEqual(lambdaInvokeStub.args[0][1], lambdaPayload);
  } finally {
    buildPayloadStub.restore();
    lambdaInvokeStub.restore();
  }
});

test.serial('applyWorkflow uses custom queueUrl, if provided', async (t) => {
  const granuleModel = new Granule();
  const granulePgModel = new GranulePgModel();

  const granule = fakeGranuleFactoryV2({
    collectionId: t.context.collectionId,
  });
  const workflow = randomString();
  const queueUrl = randomString();

  const dynamoGranule = await granuleModel.create(granule);
  await granulePgModel.create(
    t.context.knex,
    await translateApiGranuleToPostgresGranule({
      dynamoRecord: dynamoGranule,
      knexOrTransaction: t.context.knex,
    })
  );

  const buildPayloadStub = sinon.stub(Rule, 'buildPayload').resolves();
  const lambdaInvokeStub = sinon.stub(Lambda, 'invoke').resolves();

  try {
    await applyWorkflow({ granule, workflow, queueUrl });

    t.true(buildPayloadStub.called);
    t.like(buildPayloadStub.args[0][0], {
      queueUrl,
    });
  } finally {
    buildPayloadStub.restore();
    lambdaInvokeStub.restore();
  }
});
