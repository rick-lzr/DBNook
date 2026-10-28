// Startup cancellation fixture: a real child process that accepts input but
// deliberately does not complete its protocol handshake.
process.stdin.resume();
