const request = require('supertest');
const sinon = require('sinon');
const test = require('ava');

const asyncOperations = require('@cumulus/async-operations');
const { s3 } = require('@cumulus/aws-client/services');
const {
  recursivelyDeleteS3Bucket,
} = require('@cumulus/aws-client/S3');
const { randomId } = require('@cumulus/common/test-utils');

const { createFakeJwtAuthToken, setAuthorizedOAuthUsers } = require('../../lib/testUtils');

const models = require('../../models');

const { app } = require('../../app');

const { post } = require('../../endpoints/migrationCounts');
const { buildFakeExpressResponse } = require('./utils');

process.env = {
  ...process.env,
  AccessTokensTable: randomId('AccessTokensTable'),
  AsyncOperationsTable: randomId('asyncOperationsTable'),
  system_bucket: randomId('bucket'),
  stackName: randomId('stackName'),
  TOKEN_SECRET: randomId('tokenSecret'),
};

let accessTokenModel;
let jwtAuthToken;

test.before(async (t) => {
  await s3().createBucket({ Bucket: process.env.system_bucket });

  const username = randomId('username');
  await setAuthorizedOAuthUsers([username]);

  accessTokenModel = new models.AccessToken();
  await accessTokenModel.createTable();

  jwtAuthToken = await createFakeJwtAuthToken({ accessTokenModel, username });
  const asyncOperationId = randomId('asyncOperationId');
  t.context.asyncOperationStartStub = sinon.stub(asyncOperations, 'startAsyncOperation').returns(
    new Promise((resolve) => resolve({ id: asyncOperationId }))
  );
});

test.afterEach.always((t) => {
  t.context.asyncOperationStartStub.resetHistory();
});

test.after.always(async (t) => {
  t.context.asyncOperationStartStub.restore();
  await Promise.all([
    recursivelyDeleteS3Bucket(process.env.system_bucket),
    accessTokenModel.deleteTable()]);
});

test.serial('POST /migrationCounts starts an async-operation with the correct payload', async (t) => {
  const { asyncOperationStartStub } = t.context;
  const reportBucket = 'reportBucket';
  const reportPath = 'reportPath';
  const cutoffSeconds = 500;
  const dbConcurrency = 20;
  const dbMaxPool = 20;

  const body = {
    cutoffSeconds,
    dbConcurrency,
    dbMaxPool,
    reportBucket,
    reportPath,
  };

  const response = await request(app)
    .post('/migrationCounts')
    .set('Accept', 'application/json')
    .set('Authorization', `Bearer ${jwtAuthToken}`)
    .send(body)
    .expect(202);
  // expect a returned async operation ID
  t.truthy(response.body.id);
  const {
    lambdaName,
    cluster,
    description,
    payload,
  } = asyncOperationStartStub.args[0][0];
  t.true(asyncOperationStartStub.calledOnce);
  t.is(lambdaName, process.env.MigrationCountToolLambda);
  t.is(cluster, process.env.EcsCluster);
  t.is(description, 'Migration Count Tool ECS Run');
  t.deepEqual(payload, {
    reportBucket: 'reportBucket',
    reportPath: 'reportPath',
    cutoffSeconds: 500,
    dbConcurrency: 20,
    dbMaxPool: 20,
  });
});

test.serial('post() uses correct caller lambda function name', async (t) => {
  const { asyncOperationStartStub } = t.context;
  const reportBucket = 'reportBucket';
  const reportPath = 'reportPath';
  const cutoffSeconds = 500;
  const dbConcurrency = 20;
  const dbMaxPool = 20;

  const body = {
    cutoffSeconds,
    dbConcurrency,
    dbMaxPool,
    reportBucket,
    reportPath,
  };

  const functionName = randomId('lambda');

  await post(
    {
      apiGateway: {
        context: {
          functionName,
        },
      },
      body,
    },
    buildFakeExpressResponse()
  );

  t.is(asyncOperationStartStub.getCall(0).firstArg.callerLambdaName, functionName);
});
