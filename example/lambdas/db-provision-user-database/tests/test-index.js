const AWS = require('aws-sdk');
const Knex = require('knex');
const test = require('ava');
const sinon = require('sinon');

const { randomString } = require('@cumulus/common/test-utils');
const { config } = require('@cumulus/db');
const { handler } = require('../dist/lambda');

const knex = Knex({
  client: 'pg',
  connection: {
    host: 'localhost',
    user: 'postgres',
    password: 'password',
  },
});

const dbConnectionConfig = {
  user: 'postgres',
  password: 'password',
  database: 'postgres',
  host: 'localhost',
};

sinon.stub(config, 'getConnectionConfig').resolves(dbConnectionConfig);
sinon.stub(AWS, 'SecretsManager').returns({
  putSecretValue: () => ({ promise: () => Promise.resolve() }),
});

test.beforeEach(async (t) => {
  const randomDbString = randomString(10);
  const dbUser = `${randomDbString}-${randomDbString}-test`;
  const expectedDbUser = `${randomDbString}_${randomDbString}_test`;
  t.context = {
    dbUser,
    expectedDbUser,
    testDb: `${dbUser}-db`,
    expectedTestDb: `${expectedDbUser}_db`,
    handlerEvent: {
      prefix: dbUser,
      rootLoginSecret: 'bogusSecret',
      userLoginSecret: 'bogus',
      engine: 'pg',
      dbPassword: 'testPassword',
      dbClusterIdentifier: 'fake-cluster',
    },
  };
});

test.afterEach.always(async (t) => {
  await knex.raw(`drop database if exists "${t.context.expectedTestDb}"`);
  await knex.raw(`drop user if exists "${t.context.expectedDbUser}"`);
});

test('provision user database creates the expected database', async (t) => {
  const {
    expectedDbUser,
    expectedTestDb,
    handlerEvent,
  } = t.context;

  await handler(handlerEvent);

  const userResults = await knex('pg_catalog.pg_user')
    .where(knex.raw(`usename = CAST('${expectedDbUser}' as name)`));
  const dbResults = await knex('pg_database')
    .select('datname')
    .where(knex.raw(`datname = CAST('${expectedTestDb}' as name)`));
  t.is(userResults.length, 1);
  t.is(dbResults.length, 1);
  t.is(dbResults[0].datname, `${expectedTestDb}`);
  t.is(userResults[0].usename, `${expectedDbUser}`);
});

test('provision user fails if invalid password string is used', async (t) => {
  await t.throwsAsync(handler({
    ...t.context.handlerEvent,
    dbPassword: 'badPassword<>$$ <>',
  }));
});

test('provision user fails if invalid user string is used', async (t) => {
  await t.throwsAsync(handler({
    ...t.context.handlerEvent,
    prefix: 'user with bad chars <>$',
  }));
});

test('provision user updates the user password if the user already exists', async (t) => {
  const {
    expectedDbUser,
    expectedTestDb,
    handlerEvent,
  } = t.context;

  await handler(handlerEvent);
  handlerEvent.dbPassword = 'newPassword';
  await handler(handlerEvent);

  const testUserKnex = Knex({
    client: 'pg',
    connection: {
      host: 'localhost',
      user: expectedDbUser,
      password: 'newPassword',
      database: expectedTestDb,
    },
  });
  const heartBeat = await testUserKnex.raw('SELECT 1');
  testUserKnex.destroy();
  t.is(heartBeat.rowCount, 1);
});

test('provision user fails if event with no username or password is passed', async (t) => {
  const {
    handlerEvent,
  } = t.context;
  delete handlerEvent.prefix;
  delete handlerEvent.dbPassword;
  await t.throwsAsync(handler(handlerEvent));
});