// Quick test to verify the limit injection logic
function injectLimitIfNeeded(command, maxResults) {
  // Check if the command returns a cursor that could have large results
  const cursorMethods = ['find(', 'aggregate('];
  const hasCursorMethod = cursorMethods.some(method => command.includes(method));

  if (!hasCursorMethod) {
    return command; // Not a cursor-returning query, no limit needed
  }

  // Check if limit is already specified
  if (command.includes('.limit(')) {
    return command; // User has already specified a limit
  }

  // Check if there are other cursor methods that might conflict
  const hasConflictingMethods = command.includes('.forEach(') ||
                                command.includes('.map(') ||
                                command.includes('.explain(') ||
                                command.includes('.count(');

  if (hasConflictingMethods) {
    return command; // Don't inject limit if there are conflicting cursor methods
  }

  // Find the position to inject .limit() - before .toArray() or at the end
  const toArrayIndex = command.lastIndexOf('.toArray()');
  if (toArrayIndex !== -1) {
    // Inject before .toArray()
    return command.slice(0, toArrayIndex) + `.limit(${maxResults})` + command.slice(toArrayIndex);
  }

  // Check for other terminators like .sort(), .skip(), etc.
  const terminators = ['.sort(', '.skip(', '.project(', '.hint('];
  let lastTerminatorIndex = -1;
  let lastTerminatorEnd = -1;

  for (const terminator of terminators) {
    const index = command.lastIndexOf(terminator);
    if (index > lastTerminatorIndex) {
      lastTerminatorIndex = index;
      // Find the closing parenthesis for this terminator
      let parenCount = 0;
      let startSearch = index + terminator.length;
      for (let i = startSearch; i < command.length; i++) {
        if (command[i] === '(') parenCount++;
        else if (command[i] === ')') {
          if (parenCount === 0) {
            lastTerminatorEnd = i + 1;
            break;
          }
          parenCount--;
        }
      }
    }
  }

  if (lastTerminatorEnd > 0) {
    // Inject after the last terminator
    return command.slice(0, lastTerminatorEnd) + `.limit(${maxResults})` + command.slice(lastTerminatorEnd);
  }

  // Default: append at the end if it's a simple query
  if (command.endsWith(')')) {
    return command + `.limit(${maxResults})`;
  }

  return command; // Couldn't determine safe injection point
}

// Test cases
console.log('Testing limit injection:');

const testCases = [
  'db.notification_config.find({})',
  'db.users.find({}).sort({createdAt: -1})',
  'db.orders.find({}).skip(10).sort({total: -1})',
  'db.products.find({}).sort({name: 1}).limit(5)', // Already has limit
  'db.logs.find({}).count()', // Has conflicting method
  'db.items.aggregate([{$match: {}}])',
  'db.records.insertOne({name: "test"})', // Not a cursor method
];

testCases.forEach(cmd => {
  const result = injectLimitIfNeeded(cmd, 100);
  console.log(`Original: ${cmd}`);
  console.log(`Result:   ${result}`);
  console.log('---');
});