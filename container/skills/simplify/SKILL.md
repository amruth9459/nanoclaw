---
name: simplify
description: Simplify complex code, documentation, or technical content — refactor verbose code, reduce dependencies, explain concepts in plain language, and make systems more maintainable. Use when code is too complex or documentation is unclear.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
---

# Simplify Skill

This skill helps reduce complexity in code, documentation, and technical systems by applying simplification principles.

## When to Use This Skill

Activate this skill when:
- Code is too complex or hard to understand
- Functions are too long or doing too much
- Dependencies are excessive
- Documentation is unclear or overly technical
- Abstractions are over-engineered
- You need to refactor legacy code
- Explaining technical concepts to non-technical users

## Simplification Principles

### 1. Code Simplification
- **Reduce Nesting**: Flatten nested conditionals with early returns
- **Extract Functions**: Break large functions into smaller, focused ones
- **Remove Duplication**: DRY principle (Don't Repeat Yourself)
- **Simplify Logic**: Use clear conditionals, avoid clever tricks
- **Reduce Dependencies**: Remove unused imports and libraries

### 2. Documentation Simplification
- **Plain Language**: Replace jargon with simple terms
- **Clear Structure**: Use headings, lists, examples
- **Focus on Why**: Explain intent, not just implementation
- **Remove Cruft**: Delete outdated or redundant content

### 3. Architecture Simplification
- **Fewer Abstractions**: Remove unnecessary layers
- **Direct Solutions**: Avoid over-engineering
- **Standard Patterns**: Use well-known patterns
- **Minimize Configuration**: Sensible defaults

## Simplification Techniques

### Before: Complex Nested Logic
```typescript
function processUser(user: User | null) {
  if (user) {
    if (user.isActive) {
      if (user.roles) {
        if (user.roles.includes('admin')) {
          return 'admin';
        } else if (user.roles.includes('user')) {
          return 'user';
        } else {
          return 'unknown';
        }
      } else {
        return 'no-roles';
      }
    } else {
      return 'inactive';
    }
  } else {
    return 'no-user';
  }
}
```

### After: Simplified with Early Returns
```typescript
function processUser(user: User | null): string {
  if (!user) return 'no-user';
  if (!user.isActive) return 'inactive';
  if (!user.roles) return 'no-roles';

  if (user.roles.includes('admin')) return 'admin';
  if (user.roles.includes('user')) return 'user';
  return 'unknown';
}
```

### Before: Long Function Doing Too Much
```typescript
function handleUserRegistration(data: any) {
  // Validate data
  if (!data.email || !data.password) {
    throw new Error('Missing fields');
  }
  if (!data.email.includes('@')) {
    throw new Error('Invalid email');
  }
  if (data.password.length < 8) {
    throw new Error('Password too short');
  }

  // Hash password
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(data.password, salt, 1000, 64, 'sha512');

  // Create user
  const user = {
    email: data.email,
    passwordHash: hash.toString('hex'),
    salt: salt.toString('hex'),
    createdAt: new Date(),
  };

  // Save to database
  db.users.insert(user);

  // Send email
  sendEmail({
    to: data.email,
    subject: 'Welcome!',
    body: 'Thanks for registering',
  });

  return user;
}
```

### After: Extracted into Focused Functions
```typescript
function validateUserData(data: unknown): { email: string; password: string } {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid data');
  }

  const { email, password } = data as any;

  if (!email || !email.includes('@')) {
    throw new Error('Invalid email');
  }
  if (!password || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }

  return { email, password };
}

function hashPassword(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512');

  return {
    hash: hash.toString('hex'),
    salt: salt.toString('hex'),
  };
}

function createUser(email: string, passwordData: { hash: string; salt: string }) {
  return {
    email,
    passwordHash: passwordData.hash,
    salt: passwordData.salt,
    createdAt: new Date(),
  };
}

async function handleUserRegistration(data: unknown) {
  const { email, password } = validateUserData(data);
  const passwordData = hashPassword(password);
  const user = createUser(email, passwordData);

  await db.users.insert(user);
  await sendWelcomeEmail(email);

  return user;
}
```

## Simplification Strategies

### 1. Identify Complexity
- Lines of code per function (aim for < 50)
- Cyclomatic complexity (aim for < 10)
- Number of dependencies
- Levels of nesting (aim for < 3)

### 2. Refactor Step-by-Step
1. **Extract**: Pull out logical chunks
2. **Rename**: Use clear, descriptive names
3. **Remove**: Delete dead code and unused imports
4. **Reorganize**: Group related code together
5. **Test**: Ensure behavior unchanged

### 3. Documentation Simplification
```markdown
<!-- Before: Technical Jargon -->
The RPC layer leverages gRPC's bidirectional streaming semantics
to facilitate asynchronous request multiplexing across the wire
protocol, enabling non-blocking I/O operations with backpressure
signaling via flow control mechanisms.

<!-- After: Plain Language -->
The API uses streaming to send multiple requests at once without
waiting for responses. It automatically slows down if the server
gets overwhelmed.
```

## Anti-Patterns to Avoid

### Over-Abstraction
```typescript
// Bad: Too abstract
class AbstractFactoryBeanProducerFactory {
  createFactory(): AbstractFactoryBeanProducer {
    return new ConcreteFactoryBeanProducerImpl();
  }
}

// Good: Direct
function createUser(data: UserData): User {
  return new User(data);
}
```

### Premature Optimization
```typescript
// Bad: Optimizing before knowing if it's needed
const cache = new Map();
function getValue(key: string) {
  if (!cache.has(key)) {
    cache.set(key, expensiveOperation(key));
  }
  return cache.get(key);
}

// Good: Start simple, optimize if needed
function getValue(key: string) {
  return expensiveOperation(key);
}
```

## Workflow

1. **Analyze**: Identify complex areas
   - Run complexity metrics
   - Read through code
   - Find pain points

2. **Prioritize**: Focus on high-impact areas
   - Frequently changed code
   - Bug-prone sections
   - Team complaints

3. **Simplify**: Apply techniques
   - Extract functions
   - Reduce nesting
   - Remove duplication
   - Clear naming

4. **Test**: Verify correctness
   - Run existing tests
   - Add new tests if needed
   - Manual verification

5. **Document**: Explain changes
   - Why simplified
   - What changed
   - New structure

## Metrics for Success

**Before Simplification:**
- Function: 150 lines
- Cyclomatic complexity: 18
- Nested levels: 5
- Test coverage: 60%

**After Simplification:**
- Functions: 3-5 smaller functions (< 30 lines each)
- Cyclomatic complexity: < 8 per function
- Nested levels: < 3
- Test coverage: 80%+

## Common Use Cases

### Simplify Error Handling
```typescript
// Before
try {
  const user = await getUser(id);
  if (user) {
    try {
      const data = await getUserData(user.id);
      return data;
    } catch (err) {
      console.error('Failed to get data');
      throw err;
    }
  } else {
    throw new Error('No user');
  }
} catch (err) {
  console.error('Error');
  throw err;
}

// After
const user = await getUser(id);
if (!user) throw new Error('User not found');

return await getUserData(user.id);
```

### Simplify Configuration
```typescript
// Before: Too many options
interface Config {
  enableFeatureA?: boolean;
  enableFeatureB?: boolean;
  enableFeatureC?: boolean;
  featureATimeout?: number;
  featureBRetries?: number;
  featureCCacheSize?: number;
  // ... 20 more options
}

// After: Sensible defaults, fewer knobs
interface Config {
  features?: ('a' | 'b' | 'c')[];
  timeout?: number; // Default: 5000
  retries?: number; // Default: 3
}
```

## Output Format

When simplifying code:
1. **Show before/after** for clarity
2. **Explain the simplification** applied
3. **Highlight improvements** (readability, maintainability)
4. **Note any trade-offs** (if any)

## Notes

- **Simplicity !== Brevity**: Clear is better than clever
- **Test thoroughly**: Simplification shouldn't change behavior
- **Document intent**: Explain why code exists
- **Iterate**: Simplify in small steps
- **Get feedback**: Review with team
