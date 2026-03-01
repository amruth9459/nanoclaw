---
name: frontend-design
description: Design and prototype frontend UIs with modern frameworks — create React/Vue components, build layouts, design systems, and interactive prototypes. Use for UI/UX design tasks, component creation, and frontend architecture planning.
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch
---

# Frontend Design Skill

This skill helps design and build frontend user interfaces using modern frameworks and best practices.

## When to Use This Skill

Activate this skill when:
- Designing new UI components or pages
- Creating React, Vue, or other framework components
- Building design systems or component libraries
- Prototyping interactive interfaces
- Planning frontend architecture
- Creating CSS/Tailwind layouts
- Designing responsive interfaces

## Capabilities

### Component Design
- Create React/Vue/Svelte components with TypeScript
- Design reusable UI component libraries
- Implement design system patterns
- Build accessible components (WCAG compliance)

### Layout & Styling
- CSS Grid and Flexbox layouts
- Tailwind CSS utility-first design
- Responsive design (mobile-first)
- CSS-in-JS solutions (styled-components, emotion)
- Animation and transitions

### Frontend Architecture
- Component composition patterns
- State management (Redux, Zustand, Context)
- Data fetching strategies
- Performance optimization
- Code splitting and lazy loading

### Design Systems
- Atomic design methodology
- Typography and color systems
- Spacing and sizing scales
- Component variants and theming
- Documentation and Storybook

## Workflow

1. **Understand Requirements**
   - Review design mockups or descriptions
   - Identify component hierarchy
   - Plan state management needs

2. **Design Components**
   - Create component structure
   - Define props and interfaces
   - Implement styling
   - Add interactions

3. **Build Prototypes**
   - Create working examples
   - Test responsive behavior
   - Validate accessibility

4. **Document**
   - Add component documentation
   - Create usage examples
   - Document props and APIs

## Best Practices

### React Components
```tsx
// Typed props with TypeScript
interface ButtonProps {
  variant: 'primary' | 'secondary' | 'outline';
  size?: 'sm' | 'md' | 'lg';
  onClick?: () => void;
  children: React.ReactNode;
}

// Functional component with proper typing
export const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  size = 'md',
  onClick,
  children,
}) => {
  return (
    <button
      className={`btn btn-${variant} btn-${size}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
};
```

### Accessibility
- Semantic HTML elements
- ARIA labels and roles
- Keyboard navigation support
- Focus management
- Screen reader testing

### Performance
- Memoization (React.memo, useMemo)
- Virtualization for long lists
- Code splitting
- Image optimization
- CSS containment

## Example Tasks

### Create a Dashboard Card
```tsx
interface MetricCardProps {
  title: string;
  value: number | string;
  subtitle?: string;
  trend?: {
    value: number;
    direction: 'up' | 'down';
  };
  icon?: React.ReactNode;
}

export const MetricCard: React.FC<MetricCardProps> = ({
  title,
  value,
  subtitle,
  trend,
  icon,
}) => {
  return (
    <div className="bg-white rounded-lg shadow p-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-600">{title}</p>
          <h3 className="text-2xl font-bold mt-1">{value}</h3>
          {subtitle && (
            <p className="text-xs text-gray-500 mt-1">{subtitle}</p>
          )}
        </div>
        {icon && <div className="text-blue-500">{icon}</div>}
      </div>
      {trend && (
        <div className={`mt-2 text-sm ${
          trend.direction === 'up' ? 'text-green-600' : 'text-red-600'
        }`}>
          {trend.direction === 'up' ? '↑' : '↓'} {trend.value}%
        </div>
      )}
    </div>
  );
};
```

### Build a Responsive Layout
```tsx
export const DashboardLayout: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200">
        {/* Navigation */}
      </nav>
      <div className="container mx-auto px-4 py-8">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {children}
        </div>
      </div>
    </div>
  );
};
```

## Tools & Libraries

### Recommended Stack
- **React**: Component framework
- **TypeScript**: Type safety
- **Tailwind CSS**: Utility-first styling
- **Recharts/Chart.js**: Data visualization
- **React Query**: Data fetching
- **Zustand/Redux**: State management
- **Framer Motion**: Animations

### Development Tools
- **Vite**: Fast build tool
- **Storybook**: Component documentation
- **ESLint/Prettier**: Code quality
- **Jest/Vitest**: Testing

## Output Deliverables

When completing frontend design tasks, provide:
1. **Component Code**: TypeScript/JSX files
2. **Styles**: CSS/Tailwind classes
3. **Types**: Interface definitions
4. **Documentation**: Usage examples
5. **Tests**: Component tests (if needed)

## Notes

- Always use TypeScript for type safety
- Follow accessibility best practices
- Design mobile-first, then scale up
- Use semantic HTML
- Optimize for performance from the start
- Document component APIs clearly
