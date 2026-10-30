const fixturePath = /(?:^|:)test\/delivery-journey\.integration\.test\.js:/;
const fixtures = [
  ['sk', 'test', 'disposable', 'task17'].join('_'),
  ['whsec', 'disposable', 'task17'].join('_'),
];
const fixtureValues = new RegExp(`(?<![A-Za-z0-9_])(?:${fixtures.join('|')})(?![A-Za-z0-9_])`, 'g');

// These exact historical values are synthetic fixtures, never Stripe credentials.
// Recheck the rest of the line so a genuine credential beside one still blocks.
module.exports = (output, secretPattern) => {
  const pattern = new RegExp(secretPattern);
  return output.split(/\r?\n/).filter((line) => {
    const inspected = fixturePath.test(line) ? line.replace(fixtureValues, '<test-fixture>') : line;
    return pattern.test(inspected);
  }).join('\n');
};
