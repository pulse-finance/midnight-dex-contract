# Agent Instructions

- In `test/integ/Contracts`, do not create small generic call-helper modules or wrapper functions for circuit calls.
- For contract calls that do not need transaction merging, use the methods returned by `createCircuitCallTxInterface` directly.
- For calls that do need transaction merging, keep the transaction-building and merge submission logic inline in the relevant contract helper object returned by its `make()` method.
