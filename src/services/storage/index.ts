export { IndexedDBService, indexedDBService } from './IndexedDBService'
// SupabaseService intentionally NOT re-exported from barrel to keep it out of
// the main bundle (~171kB). Consumers use dynamic import() to load it on demand:
//   import('@/services/storage/SupabaseService').then(({ supabaseService }) => ...)

