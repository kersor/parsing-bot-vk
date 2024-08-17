import { VK } from 'vk-io'
import axios from 'axios'
import * as fs from 'fs'
import path from 'path'
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'


const token_group = new VK ({
    token: process.env.TOKEN_GROUP
})
const token_service = new VK({
    token: process.env.TOKEN_SERVICE
}) 
const token_user = new VK({
    token: process.env.TOKEN_USER
})
const {updates} = token_group
const prisma = new PrismaClient()





updates.on('message_new', async (context) => {
    // Проверка User
    await funcCheckPersonId(context)

    // Создание папки Photos
    await funcCheckingFolderPhotos()  

    // Берем Домен
    const domain = context.text.split('vk.com/')[1]

    // Проверка на уникальнсоть группы в БД
    const checkGroup = await funcFoundGroup(domain)
    if(checkGroup !== null) context.send(`${domain} уже парсится, выберите другую`)

    // Информация о группе
    const groupInfo = await funcGroupGetById(domain)

    // Спарсили PHOTO
    const photos = await funcWallGet(domain, groupInfo)
 
    // Скачать ФОТО
    await funcDownloadPhotos(photos)  
});  



// Проверка User
async function funcCheckPersonId(context) {
    if(context.senderId !== 559728637 && context.text !== '/start') context.send('Вы не являетесь владельцем или администратором :D') 
    else return 
}
// Создание папки Photos
async function funcCheckingFolderPhotos() {
    if(!fs.existsSync(path.resolve('photos'))) {
        fs.mkdir(path.resolve('photos'), { recursive: true }, err => {
            if(err) console.log('Error с созданием папки: photos' , err)
            else console.log('Папка photos создана');
        })
    }
}
// Проверка на уникальнсоть группы в БД
async function funcFoundGroup (domain) {
    const result = await prisma.group.findFirst({where: {domain: domain}})
    return result
}
// Информация о группе
async function funcGroupGetById(domain) {
    const result = await token_user.api.groups.getById({
        group_id: domain
    })
    return result.groups[0]
}
// Спарсили PHOTO
async function funcWallGet (domain, groupInfo) {
    const result = await token_user.api.wall.get({
        owner_id: groupInfo.id,
        domain: domain,
        offset: 0,
        count: 1,
        filter: 'all'
    })

    let array_photo = {
        domain: domain,
        group_id: groupInfo.id,
        post_id: result.items[0].id,
        photos: []
    }
    result.items[0].attachments.map(item => {
        array_photo.photos.push({id: item.photo.id, url: item.photo.orig_photo.url})
    })

    return array_photo 
} 
// Скачать ФОТО
async function funcDownloadPhotos (photo) {
    if(!fs.existsSync(path.resolve('photos', photo.domain))) {
        fs.mkdir(path.resolve('photos', photo.domain), { recursive: true }, err => {
            if(err) console.log('Error с созданием папки: ' + photo.domain , err) 
            else console.log(`Папка ${photo.domain} создана`)
        })
    }
    
    let namePhoto = []
    const download = photo.photos.map(async item => {
        const response = await axios({
            method: "GET",
            url: item.url,
            responseType: 'stream'
        })
        
        const name = 'photo-' + item.id + '-' + photo.post_id + '.jpg'
        namePhoto.push(name)
        const pathFull = path.resolve('photos', photo.domain, name)
        const writerStream = fs.createWriteStream(pathFull)
        
        response.data.pipe(writerStream)
        
        return new Promise((resolve, reject) => {
            writerStream.on('finish', resolve);
            writerStream.on('error', reject);
        });
    })

    await Promise.all(download)
    console.log('Все фотографии загружены');
    
    await prisma.group.create({
        data: {
            group_id: photo.group_id,
            domain: photo.domain,
            post_id: photo.post_id,
            photo: {
                create: photo.photos.map((item, index) => ({
                    photo_id: item.id,
                    name: namePhoto[index]
                }))
            }
        }
    })
}








async function funcUploadServer() {
    const uploadServer = await token_user.api.photos.getWallUploadServer({
        group_id: -226970068
    })
    return uploadServer
}

async function funcBufferPhoto(photo_url) {
    const buffer = await axios({
        method: "GET",
        url: photo_url,
        responseType: 'arraybuffer'
    })
    return buffer
}




updates.start()   