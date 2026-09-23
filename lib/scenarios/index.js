const support = require('./support');
const leads = require('./leads');
const moderation = require('./moderation');

const SCENARIOS = { support, leads, moderation };
const DEFAULT_SCENARIO = 'support';

module.exports = { SCENARIOS, DEFAULT_SCENARIO };
