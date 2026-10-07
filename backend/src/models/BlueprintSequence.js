'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({ _id: String, value: { type: Number, required: true, min: 0 } }, { autoCreate: false, autoIndex: false });
module.exports = mongoose.model('BlueprintSequence', schema);
