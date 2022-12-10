const test = require('ava');

const { MissingRequiredEnvVarError } = require('@cumulus/errors');
const { getRequiredEnvVar } = require('../env');

test('getRequiredEnvVar returns an environment value if defined', (t) => {
  const result = getRequiredEnvVar('testVar', { testVar: 'testvalue' });
  t.is(result, 'testvalue');
});

test('getRequiredEnvVar throws error if not defined', (t) => {
  t.throws(
    () => getRequiredEnvVar('testVar', {}),
    { instanceOf: MissingRequiredEnvVarError }
  );
});
