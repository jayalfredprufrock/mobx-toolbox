// React reads this flag off the global object to decide whether `act(...)` is supported. Without
// it, every act() call logs "The current testing environment is not configured to support act(...)"
// and updates are not batched/flushed the way the test expects.
//
// Set globally rather than per-file so any test that renders components picks it up; it is inert in
// the tests that never touch React.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
