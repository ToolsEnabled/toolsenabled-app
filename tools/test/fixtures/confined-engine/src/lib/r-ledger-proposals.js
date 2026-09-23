'use strict';

// FIXTURE: the one export of the ENGINE's src/lib/r-ledger-proposals.js the
// host reads -- anchorFile(), the name the owner-capture spool derives its
// directory from (state/r-ledger/owner-capture-spool/ beside the ledgers).
// Resolved through the fixture runtime so the spool lands under the scratch
// root the tests own. The proposal flow itself (propose / accept / decline)
// is the engine suite's business.

const { rootPath } = require('./runtime');

function anchorFile(options = {}) {
  const root = typeof options.rootPath === 'function' ? options.rootPath : rootPath;
  return root('state', 'r-ledger', 'R-PROPOSALS');
}

module.exports = Object.freeze({ PROPOSAL_MODE: 'r-ledger-proposal', anchorFile });
