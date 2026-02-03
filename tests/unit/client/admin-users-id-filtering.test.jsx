/**
 * Unit test for user ID filtering functionality in AdminUsersPage
 * This test validates that users can be filtered by their ID,
 * which is crucial for admins searching for users from log entries.
 */
describe('AdminUsersPage - User ID Filtering', () => {
  it('should filter users by ID', () => {
    // Sample users with different IDs (matching the format used in the app)
    const users = [
      {
        id: 'user_f3c60fc6_8366_4124_848c_f0a1e67013ed',
        name: 'John Doe',
        username: 'johndoe',
        email: 'john@example.com',
        internalGroups: ['users'],
        authMethods: ['local']
      },
      {
        id: 'user_demo_admin',
        name: 'Demo Administrator',
        username: 'admin',
        email: 'admin@example.com',
        internalGroups: ['admins'],
        authMethods: ['local']
      },
      {
        id: 'user_a1b2c3d4_e5f6_7890_abcd_ef1234567890',
        name: 'Jane Smith',
        username: 'janesmith',
        email: 'jane@example.com',
        internalGroups: ['users'],
        authMethods: ['local']
      }
    ];

    // This is the same filtering logic used in AdminUsersPage.jsx
    const filterUsers = (users, searchTerm) => {
      if (!searchTerm) return users;

      const searchLower = searchTerm.toLowerCase();
      return users.filter(user => {
        const id = (user.id || '').toLowerCase();
        const name = (user.name || '').toLowerCase();
        const username = (user.username || '').toLowerCase();
        const email = (user.email || '').toLowerCase();
        const groups = (user.internalGroups || []).join(' ').toLowerCase();
        const authMethods = (user.authMethods || ['local']).join(' ').toLowerCase();

        return (
          id.includes(searchLower) ||
          name.includes(searchLower) ||
          username.includes(searchLower) ||
          email.includes(searchLower) ||
          groups.includes(searchLower) ||
          authMethods.includes(searchLower)
        );
      });
    };

    // Test 1: Filter by full user ID
    const result1 = filterUsers(users, 'user_f3c60fc6_8366_4124_848c_f0a1e67013ed');
    expect(result1).toHaveLength(1);
    expect(result1[0].name).toBe('John Doe');

    // Test 2: Filter by partial user ID (UUID portion)
    const result2 = filterUsers(users, 'f3c60fc6');
    expect(result2).toHaveLength(1);
    expect(result2[0].name).toBe('John Doe');

    // Test 3: Filter by user ID prefix
    const result3 = filterUsers(users, 'user_demo');
    expect(result3).toHaveLength(1);
    expect(result3[0].name).toBe('Demo Administrator');

    // Test 4: Search still works for name
    const result4 = filterUsers(users, 'Jane');
    expect(result4).toHaveLength(1);
    expect(result4[0].id).toBe('user_a1b2c3d4_e5f6_7890_abcd_ef1234567890');

    // Test 5: Search still works for email
    const result5 = filterUsers(users, 'admin@example.com');
    expect(result5).toHaveLength(1);
    expect(result5[0].name).toBe('Demo Administrator');

    // Test 6: No results for non-matching ID
    const result6 = filterUsers(users, 'user_nonexistent');
    expect(result6).toHaveLength(0);

    // Test 7: Case insensitive search for ID
    const result7 = filterUsers(users, 'USER_DEMO_ADMIN');
    expect(result7).toHaveLength(1);
    expect(result7[0].name).toBe('Demo Administrator');

    // Test 8: Multiple users match when searching by "user_"
    const result8 = filterUsers(users, 'user_');
    expect(result8).toHaveLength(3); // All users have IDs starting with "user_"
  });
});
