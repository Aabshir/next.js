const fs = require('node:fs')
const path = require('node:path')

module.exports = function (source) {
  const callback = this.async()
  const linkedPackage = fs.realpathSync(path.join(this.rootContext, 'linked'))
  const sibling = path.resolve(
    linkedPackage,
    '../../node_modules/sibling/index.js'
  )

  this.addDependency(sibling)
  this.getResolve()(
    linkedPackage,
    '../../node_modules/sibling/index.js',
    (err, resolved) => {
      if (err) return callback(err)
      if (resolved !== sibling) {
        return callback(new Error(`Expected ${sibling}, got ${resolved}`))
      }
      callback(null, source.replace('unprocessed', 'processed'))
    }
  )
}
