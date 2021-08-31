'use strict';

const cryptoRandomString = require('crypto-random-string');
const sinon = require('sinon');
const test = require('ava');

const awsServices = require('@cumulus/aws-client/services');
const {
  promiseS3Upload,
  recursivelyDeleteS3Bucket,
} = require('@cumulus/aws-client/S3');
const { randomString } = require('@cumulus/common/test-utils');
const { bootstrapElasticSearch } = require('@cumulus/es-client/bootstrap');
const indexer = require('@cumulus/es-client/indexer');
const { Search } = require('@cumulus/es-client/search');
const {
  CollectionPgModel,
  destroyLocalTestDb,
  ExecutionPgModel,
  FilePgModel,
  fakeCollectionRecordFactory,
  fakeExecutionRecordFactory,
  fakeFileRecordFactory,
  fakeGranuleRecordFactory,
  fakePdrRecordFactory,
  fakeProviderRecordFactory,
  fakeRuleRecordFactory,
  generateLocalTestDb,
  GranulePgModel,
  PdrPgModel,
  ProviderPgModel,
  RulePgModel,
} = require('@cumulus/db');

const {
  fakeReconciliationReportFactory,
} = require('../../lib/testUtils');

const models = require('../../models');
const indexFromDatabase = require('../../lambdas/index-from-database');
const { migrationDir } = require('../../../../lambdas/db-migration');
const {
  getWorkflowList,
} = require('../../lib/testUtils');

const workflowList = getWorkflowList();
process.env.ReconciliationReportsTable = randomString();
const reconciliationReportModel = new models.ReconciliationReport();

// create all the variables needed across this test
process.env.system_bucket = randomString();
process.env.stackName = randomString();

const tables = {
  reconciliationReportsTable: process.env.ReconciliationReportsTable,
};

async function addFakeDynamoData(numItems, factory, model, factoryParams = {}) {
  const items = [];

  /* eslint-disable no-await-in-loop */
  for (let i = 0; i < numItems; i += 1) {
    const item = factory(factoryParams);
    items.push(item);
    await model.create(item);
  }
  /* eslint-enable no-await-in-loop */

  return items;
}

async function addFakeData(knex, numItems, factory, model, factoryParams = {}) {
  const items = [];

  /* eslint-disable no-await-in-loop */
  for (let i = 0; i < numItems; i += 1) {
    const item = factory(factoryParams);
    const createdRecordId = await model.create(knex, item);
    items.push({ ...item, cumulus_id: Number(createdRecordId) });
  }
  /* eslint-enable no-await-in-loop */

  return items;
}

function searchEs(type, index) {
  const executionQuery = new Search({}, type, index);
  return executionQuery.query();
}

test.before(async (t) => {
  t.context.esIndices = [];
  //t.context.esIndex = randomString();
  //t.context.esAlias = randomString();
  // add fake elasticsearch index
  await bootstrapElasticSearch('fakehost', t.context.esIndex, t.context.esAlias);

  await awsServices.s3().createBucket({ Bucket: process.env.system_bucket }).promise();
  await reconciliationReportModel.createTable();

  const wKey = `${process.env.stackName}/workflows/${workflowList[0].name}.json`;
  const tKey = `${process.env.stackName}/workflow_template.json`;
  await Promise.all([
    promiseS3Upload({
      Bucket: process.env.system_bucket,
      Key: wKey,
      Body: JSON.stringify(workflowList[0]),
    }),
    promiseS3Upload({
      Bucket: process.env.system_bucket,
      Key: tKey,
      Body: JSON.stringify({}),
    }),
  ]);
});

test.beforeEach(async (t) => {
  t.context.testDbName = `test_index_${cryptoRandomString({ length: 10 })}`;
  const { knex, knexAdmin } = await generateLocalTestDb(t.context.testDbName, migrationDir);
  t.context.knex = knex;
  t.context.knexAdmin = knexAdmin;
  t.context.esIndex = randomString();
  t.context.esAlias = randomString();
  await bootstrapElasticSearch('fakehost', t.context.esIndex, t.context.esAlias);
  t.context.esClient = await Search.es('fakehost');
});

test.afterEach.always(async (t) => {
  const { esClient, esIndex, testDbName } = t.context;
  await esClient.indices.delete({ index: esIndex });
  await destroyLocalTestDb({
    knex: t.context.knex,
    knexAdmin: t.context.knexAdmin,
    testDbName,
  });
});

test.after.always(async (t) => {
  await recursivelyDeleteS3Bucket(process.env.system_bucket);
});

test('getEsRequestConcurrency respects concurrency value in payload', (t) => {
  t.is(indexFromDatabase.getEsRequestConcurrency({
    esRequestConcurrency: 5,
  }), 5);
});

test.serial('getEsRequestConcurrency respects ES_CONCURRENCY environment variable', (t) => {
  process.env.ES_CONCURRENCY = 35;
  t.is(indexFromDatabase.getEsRequestConcurrency({}), 35);
  delete process.env.ES_CONCURRENCY;
});

test('getEsRequestConcurrency correctly returns 10 when nothing is specified', (t) => {
  t.is(indexFromDatabase.getEsRequestConcurrency({}), 10);
});

test.serial('getEsRequestConcurrency throws an error when -1 is specified', (t) => {
  t.throws(
    () => indexFromDatabase.getEsRequestConcurrency({
      esRequestConcurrency: -1,
    }),
    { instanceOf: TypeError }
  );

  process.env.ES_CONCURRENCY = -1;
  t.teardown(() => {
    delete process.env.ES_CONCURRENCY;
  });
  t.throws(
    () => indexFromDatabase.getEsRequestConcurrency({}),
    { instanceOf: TypeError }
  );
});

test.serial('getEsRequestConcurrency throws an error when "asdf" is specified', (t) => {
  t.throws(
    () => indexFromDatabase.getEsRequestConcurrency({
      esRequestConcurrency: 'asdf',
    }),
    { instanceOf: TypeError }
  );

  process.env.ES_CONCURRENCY = 'asdf';
  t.teardown(() => {
    delete process.env.ES_CONCURRENCY;
  });
  t.throws(
    () => indexFromDatabase.getEsRequestConcurrency({}),
    { instanceOf: TypeError }
  );
});

test.serial('getEsRequestConcurrency throws an error when 0 is specified', (t) => {
  t.throws(
    () => indexFromDatabase.getEsRequestConcurrency({
      esRequestConcurrency: 0,
    }),
    { instanceOf: TypeError }
  );

  process.env.ES_CONCURRENCY = 0;
  t.teardown(() => {
    delete process.env.ES_CONCURRENCY;
  });
  t.throws(
    () => indexFromDatabase.getEsRequestConcurrency({}),
    { instanceOf: TypeError }
  );
});

test('No error is thrown if nothing is in the database', async (t) => {
  const { esAlias, knex } = t.context;

  await t.notThrowsAsync(() => indexFromDatabase.indexFromDatabase({
    indexName: esAlias,
    tables,
    knex,
  }));
});

test('Lambda successfully indexes records of all types', async (t) => {
  const knex = t.context.knex;
  const { esAlias } = t.context;

  const numItems = 2;

  const fakeData = [];

  const collectionRecord = await addFakeData(knex, numItems, fakeCollectionRecordFactory, new CollectionPgModel());
  fakeData.push(collectionRecord);
  fakeData.push(await addFakeData(knex, numItems, fakeExecutionRecordFactory, new ExecutionPgModel()));
  const granuleRecord = await addFakeData(knex, numItems, fakeGranuleRecordFactory, new GranulePgModel(), { collection_cumulus_id: collectionRecord[0].cumulus_id });
  fakeData.push(granuleRecord);
  fakeData.push(await addFakeData(knex, numItems, fakeFileRecordFactory, new FilePgModel(), { granule_cumulus_id: granuleRecord[0].cumulus_id }));
  const providerRecord = await addFakeData(knex, numItems, fakeProviderRecordFactory, new ProviderPgModel());
  fakeData.push(providerRecord);
  fakeData.push(await addFakeData(knex, numItems, fakePdrRecordFactory, new PdrPgModel(), { collection_cumulus_id: collectionRecord[0].cumulus_id, provider_cumulus_id: providerRecord[0].cumulus_id }));
  fakeData.push(await addFakeDynamoData(numItems, fakeReconciliationReportFactory, reconciliationReportModel));
  fakeData.push(addFakeData(knex, numItems, fakeRuleRecordFactory, new RulePgModel(), { workflow: workflowList[0].name }));
  await indexFromDatabase.handler({
    indexName: esAlias,
    tables,
    knex,
  });

  const searchResults = await Promise.all([
    searchEs('collection', esAlias),
    searchEs('execution', esAlias),
    searchEs('granule', esAlias),
    searchEs('pdr', esAlias),
    searchEs('provider', esAlias),
    searchEs('reconciliationReport', esAlias),
    searchEs('rule', esAlias),
  ]);

  searchResults.map((res) => t.is(res.meta.count, numItems));

  searchResults.map((res, index) =>
    t.deepEqual(
      res.results.map((r) => delete r.timestamp),
      fakeData[index].map((r) => delete r.timestamp)
    ));
});

test.serial('failure in indexing record of specific type should not prevent indexing of other records with same type', async (t) => {
  const { esAlias, esClient, knex } = t.context;
  const granulePgModel = new GranulePgModel();
  const numItems = 7;
  const collectionRecord = await addFakeData(knex, 1, fakeCollectionRecordFactory, new CollectionPgModel());
  const fakeData = await addFakeData(knex, numItems, fakeGranuleRecordFactory, granulePgModel, {
    collection_cumulus_id: collectionRecord[0].cumulus_id,
    created_at: new Date(),
    updated_at: new Date(),
  });

  let numCalls = 0;
  const originalIndexGranule = indexer.indexGranule;
  const successCount = 4;
  const indexGranuleStub = sinon.stub(indexer, 'indexGranule')
    .callsFake((
      esClientArg,
      payload,
      index
    ) => {
      numCalls += 1;
      if (numCalls <= successCount) {
        return originalIndexGranule(esClientArg, payload, index);
      }
      throw new Error('fake error');
    });

  let searchResults;
  try {
    await indexFromDatabase.handler({
      indexName: esAlias,
      tables,
      knex,
    });

    searchResults = await searchEs('granule', esAlias);

    t.is(searchResults.meta.count, successCount);

    searchResults.results.forEach((result) => {
      const sourceData = fakeData.find((data) => data.granule_id === result.granuleId);
      const expected = {
        collectionId: `${collectionRecord[0].name}___${collectionRecord[0].version}`,
        granuleId: sourceData.granule_id,
        status: sourceData.status,
      };
      const actual = {
        collectionId: result.collectionId,
        granuleId: result.granuleId,
        status: result.status,
      };

      t.deepEqual(expected, actual);
    });
  } finally {
    indexGranuleStub.restore();
    await Promise.all(fakeData.map(
      // eslint-disable-next-line camelcase
      ({ granule_id }) => granulePgModel.delete(knex, { granule_id })
    ));
    await Promise.all(searchResults.results.map(
      (result) =>
        esClient.delete({
          index: esAlias,
          type: 'granule',
          id: result.granuleId,
          parent: result.collectionId,
          refresh: true,
        })
    ));
  }
});

test.serial('failure in indexing record of one type should not prevent indexing of other records with different type', async (t) => {
  const { esAlias, esClient, knex } = t.context;
  const numItems = 2;
  const collectionRecord = await addFakeData(knex, 1, fakeCollectionRecordFactory, new CollectionPgModel());
  const [fakeProviderData, fakeGranuleData] = await Promise.all([
    addFakeData(knex, numItems, fakeProviderRecordFactory, new ProviderPgModel()),
    addFakeData(knex, numItems, fakeGranuleRecordFactory, new GranulePgModel(), { collection_cumulus_id: collectionRecord[0].cumulus_id }),
  ]);

  const indexGranuleStub = sinon.stub(indexer, 'indexGranule')
    .throws(new Error('error'));

  let searchResults;
  try {
    await indexFromDatabase.handler({
      indexName: esAlias,
      tables,
      knex,
    });

    searchResults = await searchEs('provider', esAlias);

    t.is(searchResults.meta.count, numItems);

    searchResults.results.forEach((result) => {
      const sourceData = fakeProviderData.find((data) => data.name === result.id);
      t.deepEqual(
        { host: result.host, id: result.id, protocol: result.protocol },
        { host: sourceData.host, id: sourceData.name, protocol: sourceData.protocol }
      );
    });
  } finally {
    indexGranuleStub.restore();
    await Promise.all(fakeProviderData.map(({ name }) => {
      const pgModel = new ProviderPgModel();
      return pgModel.delete(knex, { name });
    }));
    await Promise.all(fakeGranuleData.map(
      // eslint-disable-next-line camelcase
      ({ granule_id }) => new GranulePgModel().delete(knex, { granule_id })
    ));
    await Promise.all(searchResults.results.map(
      (result) =>
        esClient.delete({
          index: esAlias,
          type: 'provider',
          id: result.id,
          refresh: true,
        })
    ));
  }
});
