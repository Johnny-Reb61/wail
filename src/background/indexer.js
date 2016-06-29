import {ipcRenderer} from "electron"
import child_process from "child_process"
import os from 'os'
import path from 'path'
import through2 from 'through2'
import S from 'string'
import fs from 'fs-extra'
import del from "del"
import streamSort from "sort-stream2"
import bytewise from "bytewise"
import ReadWriteLock from 'rwlock'
import settings from '../settings/settings'
import schedule from 'node-schedule'
const indexLock = new ReadWriteLock()


process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"

function generatePathIndex(genCdx) {
   let index = []
   let count = 0
   let onlyWarf = through2.obj(function (item, enc, next) {
      if (!item.stats.isDirectory() && path.extname(item.path) === '.warc') {
         this.push(item)
         count++
      }
      next()
   })
   indexLock.readLock('pindex', warcReadRelease => {
      console.log("Aquiring pindex readlock")
      fs.walk(settings.get('warcs'))
         .on('error', (err) => onlyWarf.emit('error', err)) // forward the error on
         .pipe(onlyWarf)
         .on('data', item => {
            index.push(`${path.basename(item.path)}\t${item.path}`)
         })
         .on('end', () => {
            console.log("Aquiring pindex writelock")
            indexLock.writeLock('pindex', indexWriteRelease => {
               if (count > 0) {
                  console.log('The count was greater than zero')
                  fs.writeFile(settings.get('index'), index.join(os.EOL), 'utf8', err => {
                     console.log("Releasing pindex writelock")
                     if (err) {
                        indexWriteRelease()
                        console.error('generating path index with error', err)
                        throw  err
                     } else {

                        console.log('done generating path index no error')
                        genCdx()
                     }
                  })
               } else {
                  console.log("There were no warcs to index")
                  indexWriteRelease()
               }

            })
            console.log("Releasing pindex readlock")
            warcReadRelease()
         })
   })
}

//implements bytewise sorting of export LC_ALL=C; sort
function unixSort(a, b) {
   return bytewise.compare(bytewise.encode(a), bytewise.encode(b))
}

function generateCDX() {
   let replace = /.warc+$/g
   let cdxHeaderIncluded = false

   let onlyWorf = through2.obj(function (item, enc, next) {
      if (!item.stats.isDirectory() && path.extname(item.path) === '.warc')
         this.push(item)
      next()
   })

   let cdxp = settings.get('cdx')
   let cdxIndexer = settings.get('cdxIndexer')

   let worfToCdx = through2.obj(function (item, enc, next) {
      let through = this //hope this ensures that this is through2.obj
      let cdx = path.basename(item.path).replace(replace, '.cdx')
      let cdxFile = `${cdxp}/${cdx}`
      child_process.exec(`${cdxIndexer} ${item.path} ${cdxFile}`, (err, stdout, stderr) => {
         if (err) {
            throw err
         }
         fs.readFile(cdxFile, 'utf8', (errr, value)=> {
            if (errr) {
               throw errr
            }
            through.push(value)
            next()
         })
      })
   })

   let uniqueLines = new Set()

   let cdxToLines = through2.obj(function (item, enc, next) {
      let through = this
      S(item).lines().forEach((line, index) => {
         if (!uniqueLines.has(line)) {
            if (index > 0) {
               through.push(line + os.EOL)
            } else if (!cdxHeaderIncluded) {
               through.push(line + os.EOL)
               cdxHeaderIncluded = true
            }
            uniqueLines.add(line)
         }
      })
      next()
   })


   let writeStream = fs.createWriteStream(settings.get('indexCDX'))
   indexLock.writeLock('indedxCDX', indexCDXWriteRelease => {
      console.log('Acquiring write lock for indexCDX')
      fs.walk(settings.get('warcs'))
         .on('error', (err) => onlyWorf.emit('error', err)) // forward the error on please....
         .pipe(onlyWorf)
         .on('error', (err) => worfToCdx.emit('error', err)) // forward the error on please....
         .pipe(worfToCdx)
         .pipe(cdxToLines)
         .pipe(streamSort(unixSort))
         .pipe(writeStream)
         .on('close', () => {
            writeStream.destroy()
            console.log('we have closed')
            del([settings.get('wayback.allCDX'), settings.get('wayback.notIndexCDX')], {force: true})
               .then(paths => {
                  console.log('Releaseing write lock for indexCDX')
                  console.log('Deleted files and folders:\n', paths.join('\n'))
                  indexCDXWriteRelease()
               })
         })
   })

}

class Indexer {
   constructor() {
      this.job  = null
      this.started = false
      this.indexer = this.indexer.bind(this)
   }

   indexer() {
      if (!this.started) {
         let rule   = new schedule.RecurrenceRule()
         rule.second = [0, 10, 20,30,40, 50]
         this.job = schedule.scheduleJob(rule,function () {
            generatePathIndex(generateCDX)
         })
         this.started = true
      }
   }
}


let indexer = new Indexer()


ipcRenderer.on("start-index-indexing", (event) => {
   console.log('Monitor get start indexing monitoring')
   indexer.indexer()
})


ipcRenderer.on("stop", (event) => {
   console.log('Monitor get start indexing monitoring')
   indexer.job.cancel()
   indexer.job = null
   indexer = null
})