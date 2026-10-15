/**
 * Explicit allow-list for user objects returned by API endpoints.
 * Never JSON-serialize the Mongoose User document directly: it contains
 * password hashes and provider identifiers that clients do not need.
 */
function toPublicUser(user) {
  if (!user) return null;

  const value = typeof user.toObject === 'function' ? user.toObject() : user;
  return {
    id: String(value._id ?? value.id ?? ''),
    name: value.name ?? '',
    username: value.username ?? '',
    email: value.email ?? '',
    age: value.age ?? null,
    class: value.class ?? null,
    subjects: Array.isArray(value.subjects) ? value.subjects : [],
    profilePicture: value.profilePicture ?? '',
    avatar: value.avatar ?? '',
    points: Number.isFinite(value.points) ? value.points : 0,
    unlockedCourses: Array.isArray(value.unlockedCourses) ? value.unlockedCourses : [1],
    badges: Array.isArray(value.badges) ? value.badges : [],
    createdAt: value.createdAt ?? null
  };
}

module.exports = { toPublicUser };
