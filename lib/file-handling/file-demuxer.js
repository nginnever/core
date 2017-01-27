'use strict';

var inherits = require('util').inherits;
var assert = require('assert');
var stream = require('readable-stream');
var fs = require('fs');
var EventEmitter = require('events').EventEmitter;
var merge = require('merge');
var utils = require('../utils');
var os = require('os');
var timers = require('timers');

/**
 * Takes a single file read stream and outputs several output streams, used for
 * "shredding" a file and creating muliple out destination interfaces
 * @constructor
 * @license LGPL-3.0
 * @param {String} filePath - Path the file to demultiplex
 * @param {Object} options
 * @param {Number} options.shardSize - Size of each shard
 * @fires FileDemuxer#shard
 */
function FileDemuxer(filePath, options) {
  if (!(this instanceof FileDemuxer)) {
    return new FileDemuxer(filePath, options);
  }

  //console.log(filePath.length)
  // assert(
  //   utils.existsSync(filePath),
  //   'File does not exist at the supplied path'
  // );

  options = merge(Object.create(FileDemuxer.DEFAULTS), options);

  //turn filePath into a readable Stream
  if (typeof filePath === 'string') {
    options.fileSize = fs.statSync(filePath).size;
    filePath = fs.createReadStream(filePath).on('error', function(e) {
      return this.emit('error', e);
    });
  }

  // TODO: pass size into constructor for file
  // TODO for this._source pass in readableStream from blob store
  // LONG TERM TODO: Turn into a chunk store.
  // this._fileSize = fs.statSync(filePath).size;
  this._fileSize = options.fileSize;
  this._filePosition = 0;
  this._shardSize = options.shardSize;
  this._source = filePath;
  this._currentShardIndex = 0;

  EventEmitter.call(this);
  timers.setImmediate(this._openStream.bind(this));
}

FileDemuxer.SHARD_MULTIPLES_BACK = 4;
FileDemuxer.DEFAULTS = {
  shardSize: 1024 * 1024 * 8
};

/**
 * Triggered when the demuxer has a shard ready to stream
 * @event FileDemuxer#shard
 * @param {ReadableStream} shard - The file shard as a readable stream
 */

/**
 * Triggered when the demuxer has finished writing to all shards
 * @event FileDemuxer#finish
 */

inherits(FileDemuxer, EventEmitter);

/**
 * Opens the underyling readable stream
 * @private
 */
FileDemuxer.prototype._openStream = function() {
  if (this._fileSize === 0) {
    this._currentOutput = new stream.Readable({ read: utils.noop });
    return this.emit('error', new Error('File size cannot be 0 Bytes.'));
  }

  this._source.on('data', this._handleSourceBytes.bind(this));
  // end is called before _pushBytes and closes stream
  //this._source.on('end', this._handleSourceEnded.bind(this));
};

/**
 * Handles incoming data from the source stream
 * @private
 */
FileDemuxer.prototype._handleSourceBytes = function(chunk) {

  if (!this._currentOutput) {
    this._currentOutput = new stream.Readable({ read: utils.noop });

    this.emit('shard', this._currentOutput, this._currentShardIndex);
  }

  if (this._needsNewOutputStream()) {
    this._closeCurrentOutput();

    this._currentOutput = new stream.Readable({ read: utils.noop });

    this.emit('shard', this._currentOutput, ++this._currentShardIndex);
  }
  //timers.setImmediate(this._pushBytesToOutput.bind(this, chunk));
  this._currentOutput.push(chunk);
  this._currentOutput.push(null);
};

/**
 * Closes the current output source and emits a finish event
 * @private
 */
FileDemuxer.prototype._handleSourceEnded = function() {
  this._closeCurrentOutput();
  this.emit('finish');
};

/**
 * Simply pushes the given bytes to the current output
 * @private
 */
FileDemuxer.prototype._pushBytesToOutput = function(bytes) {

  if (bytes) {
    this._filePosition += bytes.length;
  }
  
  this._currentOutput.push(bytes);
};

/**
 * Simply closes the output stream
 * @private
 */
FileDemuxer.prototype._closeCurrentOutput = function() {
  this._pushBytesToOutput(null);
};

/**
 * Returns a boolean indicating if we should create a new shard stream
 * @private
 */
FileDemuxer.prototype._needsNewOutputStream = function() {
  var expectedIndex = Math.floor(this._filePosition / this._shardSize);

  return this._currentShardIndex < expectedIndex;
};

/**
 * Determine the optimal shard size given an arbitrary file size in bytes
 * @param {Object} fileInfo
 * @param {Number} fileInfo.fileSize - The number of bytes in the given file
 * @param {Number} fileInfo.shardConcurrency - Num of shards uploaded at once
 * @param {Number} [acc=1] - Accumulator (number of recursions)
 * @returns {Number} shardSize
 */
FileDemuxer.getOptimalShardSize = function(fileInfo, acc) {
  var accumulator = typeof acc === 'undefined' ? 0 : acc;

  // Determine hops back by accumulator
  var hops = (accumulator - FileDemuxer.SHARD_MULTIPLES_BACK) < 0 ?
                 0 :
                 accumulator - FileDemuxer.SHARD_MULTIPLES_BACK;

  // Calculate bytemultiple shard size by hops back
  var shardSize = function(hops) {
    return (8 * (1024 * 1024)) * Math.pow(2, hops);
  };

  var byteMultiple = shardSize(accumulator);
  var check = fileInfo.fileSize / byteMultiple;

  // Determine if bytemultiple is highest bytemultiple that is still <= fileSize
  if (check > 0 && check <= 1) {

    // Certify the number of concurrency * shardSize doesn't exceed freemem
    while (
      hops > 0 &&
      (os.freemem() / shardSize(hops) <= fileInfo.shardConcurrency)
    ) {
      hops = hops - 1 <= 0 ? 0 : hops - 1;
    }

    return shardSize(hops);
  }

  return this.getOptimalShardSize(fileInfo, ++accumulator);
};

module.exports = FileDemuxer;
