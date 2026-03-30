module.exports = async function beforeBuild() {
  // The packaged app only needs the built dist assets and bundled processor.
  // Skipping Electron Builder's dependency install/rebuild step avoids a
  // workspace-specific CI failure while keeping the installer contents intact.
  return false
}
