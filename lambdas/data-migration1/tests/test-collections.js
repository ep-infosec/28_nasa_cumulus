const cryptoRandomString = require('crypto-random-string');
const omit = require('lodash/omit');
const test = require('ava');

const Collection = require('@cumulus/api/models/collections');
const Rule = require('@cumulus/api/models/rules');
const { dynamodbDocClient } = require('@cumulus/aws-client/services');
const {
  createBucket,
  recursivelyDeleteS3Bucket,
} = require('@cumulus/aws-client/S3');
const {
  generateLocalTestDb,
  destroyLocalTestDb,
  CollectionPgModel,
  migrationDir,
} = require('@cumulus/db');
const { RecordAlreadyMigrated } = require('@cumulus/errors');

const {
  migrateCollectionRecord,
  migrateCollections,
} = require('../dist/lambda/collections');

const testDbName = `data_migration_1_${cryptoRandomString({ length: 10 })}`;

const generateFakeCollection = (params) => ({
  name: `${cryptoRandomString({ length: 10 })}collection`,
  version: '0.0.0',
  duplicateHandling: 'replace',
  granuleId: '^MOD09GQ\\.A[\\d]{7}\.[\\S]{6}\\.006\\.[\\d]{13}$',
  granuleIdExtraction: '(MOD09GQ\\.(.*))\\.hdf',
  sampleFileName: 'MOD09GQ.A2017025.h21v00.006.2017034065104.hdf',
  files: [{ regex: '^.*\\.txt$', sampleFileName: 'file.txt', bucket: 'bucket' }],
  meta: { foo: 'bar', key: { value: 'test' } },
  reportToEms: false,
  ignoreFilesConfigForDiscovery: false,
  process: 'modis',
  url_path: 'path',
  tags: ['tag1', 'tag2'],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...params,
});

let collectionsModel;
let rulesModel;
const collectionOmitList = ['granuleId', 'granuleIdExtraction', 'sampleFileName', 'granuleIdValidationRegex', 'granuleIdExtractionRegex', 'ignoreFilesConfigForDiscovery', 'duplicateHandling', 'reportToEms', 'createdAt', 'updatedAt'];

test.before(async (t) => {
  process.env.stackName = cryptoRandomString({ length: 10 });
  process.env.system_bucket = cryptoRandomString({ length: 10 });
  process.env.CollectionsTable = cryptoRandomString({ length: 10 });
  process.env.RulesTable = cryptoRandomString({ length: 10 });

  await createBucket(process.env.system_bucket);

  collectionsModel = new Collection();
  await collectionsModel.createTable();

  rulesModel = new Rule();
  await rulesModel.createTable();

  t.context.collectionPgModel = new CollectionPgModel();

  const { knex, knexAdmin } = await generateLocalTestDb(testDbName, migrationDir);
  t.context.knex = knex;
  t.context.knexAdmin = knexAdmin;
});

test.afterEach.always(async (t) => {
  await t.context.knex('collections').del();
});

test.after.always(async (t) => {
  await collectionsModel.deleteTable();
  await rulesModel.deleteTable();
  await recursivelyDeleteS3Bucket(process.env.system_bucket);
  await destroyLocalTestDb({
    knex: t.context.knex,
    knexAdmin: t.context.knexAdmin,
    testDbName,
  });
});

test.serial('migrateCollectionRecord correctly migrates collection record', async (t) => {
  const { knex, collectionPgModel } = t.context;

  const fakeCollection = generateFakeCollection();
  await migrateCollectionRecord(fakeCollection, t.context.knex);

  const createdRecord = await collectionPgModel.get(
    knex,
    { name: fakeCollection.name, version: fakeCollection.version }
  );

  t.deepEqual(
    omit(createdRecord, ['cumulus_id']),
    omit(
      {
        ...fakeCollection,
        sample_file_name: fakeCollection.sampleFileName,
        granule_id_validation_regex: fakeCollection.granuleId,
        granule_id_extraction_regex: fakeCollection.granuleIdExtraction,
        duplicate_handling: fakeCollection.duplicateHandling,
        report_to_ems: fakeCollection.reportToEms,
        ignore_files_config_for_discovery: fakeCollection.ignoreFilesConfigForDiscovery,
        created_at: new Date(fakeCollection.createdAt),
        updated_at: new Date(fakeCollection.updatedAt),
      },
      collectionOmitList
    )
  );
});

test.serial('migrateCollectionRecord throws error on invalid source data from Dynamo', async (t) => {
  const fakeCollection = generateFakeCollection();

  // make source record invalid
  delete fakeCollection.files;

  await t.throwsAsync(migrateCollectionRecord(fakeCollection, t.context.knex));
});

test.serial('migrateCollectionRecord handles nullable fields on source collection data', async (t) => {
  const fakeCollection = generateFakeCollection();

  // remove nullable fields
  delete fakeCollection.dataType;
  delete fakeCollection.url_path;
  delete fakeCollection.duplicateHandling;
  delete fakeCollection.process;
  delete fakeCollection.reportToEms;
  delete fakeCollection.ignoreFilesConfigForDiscovery;
  delete fakeCollection.meta;
  delete fakeCollection.tags;

  await migrateCollectionRecord(fakeCollection, t.context.knex);
  const { knex, collectionPgModel } = t.context;

  const createdRecord = await collectionPgModel.get(
    knex,
    { name: fakeCollection.name, version: fakeCollection.version }
  );

  t.deepEqual(
    omit(createdRecord, ['cumulus_id']),
    omit(
      {
        ...fakeCollection,
        sample_file_name: fakeCollection.sampleFileName,
        granule_id_validation_regex: fakeCollection.granuleId,
        granule_id_extraction_regex: fakeCollection.granuleIdExtraction,
        url_path: null,
        process: null,
        ignore_files_config_for_discovery: null,
        meta: null,
        tags: null,
        created_at: new Date(fakeCollection.createdAt),
        updated_at: new Date(fakeCollection.updatedAt),
        duplicate_handling: null,
        report_to_ems: null,
      },
      collectionOmitList
    )
  );
});

test.serial('migrateCollectionRecord ignores extraneous fields from Dynamo', async (t) => {
  const fakeCollection = generateFakeCollection();

  // add extraneous fields from Dynamo that will not exist in RDS
  fakeCollection.dataType = 'data-type';

  await t.notThrowsAsync(migrateCollectionRecord(fakeCollection, t.context.knex));
});

test.serial('migrateCollectionRecord throws RecordAlreadyMigrated error if already migrated record is newer', async (t) => {
  const fakeCollection = generateFakeCollection({
    updatedAt: Date.now(),
  });

  await migrateCollectionRecord(fakeCollection, t.context.knex);

  const olderFakeCollection = {
    ...fakeCollection,
    updatedAt: Date.now() - 1000, // older than fakeAsyncOp
  };

  await t.throwsAsync(
    migrateCollectionRecord(olderFakeCollection, t.context.knex),
    { instanceOf: RecordAlreadyMigrated }
  );
});

test.serial('migrateCollectionRecord updates an already migrated record if the updated date is newer', async (t) => {
  const { knex, collectionPgModel } = t.context;

  const fakeCollection = generateFakeCollection({
    updatedAt: Date.now() - 1000,
  });
  await migrateCollectionRecord(fakeCollection, t.context.knex);

  const newerFakeCollection = generateFakeCollection({
    ...fakeCollection,
    updatedAt: Date.now(),
  });
  await migrateCollectionRecord(newerFakeCollection, t.context.knex);

  const createdRecord = await collectionPgModel.get(
    knex,
    { name: fakeCollection.name, version: fakeCollection.version }
  );

  t.deepEqual(createdRecord.updated_at, new Date(newerFakeCollection.updatedAt));
});

test.serial('migrateCollections skips already migrated record', async (t) => {
  const { knex, collectionPgModel } = t.context;

  const fakeCollection = generateFakeCollection();

  await migrateCollectionRecord(fakeCollection, t.context.knex);
  await collectionsModel.create(fakeCollection);
  t.teardown(() => collectionsModel.delete(fakeCollection));
  const migrationSummary = await migrateCollections(process.env, t.context.knex);
  t.deepEqual(migrationSummary, {
    dynamoRecords: 1,
    skipped: 1,
    failed: 0,
    success: 0,
  });
  const records = await collectionPgModel.search(
    knex,
    {}
  );
  t.is(records.length, 1);
});

test.serial('migrateCollections processes multiple collections', async (t) => {
  const { knex, collectionPgModel } = t.context;

  const fakeCollection1 = generateFakeCollection();
  const fakeCollection2 = generateFakeCollection();

  await Promise.all([
    collectionsModel.create(fakeCollection1),
    collectionsModel.create(fakeCollection2),
  ]);
  t.teardown(() => Promise.all([
    collectionsModel.delete(fakeCollection1),
    collectionsModel.delete(fakeCollection2),
  ]));

  const migrationSummary = await migrateCollections(process.env, t.context.knex);
  t.deepEqual(migrationSummary, {
    dynamoRecords: 2,
    skipped: 0,
    failed: 0,
    success: 2,
  });
  const records = await collectionPgModel.search(
    knex,
    {}
  );
  t.is(records.length, 2);
});

test.serial('migrateCollections processes all non-failing records', async (t) => {
  const { knex, collectionPgModel } = t.context;

  const fakeCollection1 = generateFakeCollection();
  const fakeCollection2 = generateFakeCollection();

  // remove required source field so that record will fail
  delete fakeCollection1.sampleFileName;

  await Promise.all([
    // Have to use Dynamo client directly because creating
    // via model won't allow creation of an invalid record
    dynamodbDocClient().put({
      TableName: process.env.CollectionsTable,
      Item: fakeCollection1,
    }),
    collectionsModel.create(fakeCollection2),
  ]);
  t.teardown(() => Promise.all([
    collectionsModel.delete(fakeCollection1),
    collectionsModel.delete(fakeCollection2),
  ]));

  const migrationSummary = await migrateCollections(process.env, t.context.knex);
  t.deepEqual(migrationSummary, {
    dynamoRecords: 2,
    skipped: 0,
    failed: 1,
    success: 1,
  });
  const records = await collectionPgModel.search(
    knex,
    {}
  );
  t.is(records.length, 1);
});
